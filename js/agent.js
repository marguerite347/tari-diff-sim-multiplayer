'use strict';

/**
 * Copilot — an autopilot agent that plays your mining rigs for you and
 * narrates every decision with its reasoning.
 *
 * It reads the same public state a human sees (power totals, per-algo
 * difficulty telemetry, recent win shares, the round objective) and
 * reallocates your hashrate a few blocks at a time, explaining each move
 * in the decision log.
 */
const Copilot = (function () {
  const ALGO = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo'];
  const STEP = 10;             // slider granularity
  const PER_ALGO_MAX = 300;    // slider max
  const SURGE_THRESHOLD = 120; // outside power delta that reads as an attack
  const MEMORY_KEY = 'copilotMemory.v1';
  const EXPLORE_RATE = 0.25;   // chance to try a non-best strategy and keep learning

  /**
   * Strategy profiles — the tunables the agent learns over. Memory tracks how
   * each profile performs per (challenge, variant) and future rounds pick the
   * best performer (with some exploration).
   */
  const PROFILES = {
    balanced: {
      label: 'BALANCED',
      desc: 'moderate counter-moves, moderate patience',
      avoidMult: 0.15, strandedBoost: 3, cooldown: 4, budget: 400, counterWeight: 0.7,
    },
    hardCounter: {
      label: 'HARD COUNTER',
      desc: 'aggressive counter-weighting, fast reactions, full budget',
      avoidMult: 0.05, strandedBoost: 4.5, cooldown: 3, budget: 400, counterWeight: 1.0,
    },
    lightTouch: {
      label: 'LIGHT TOUCH',
      desc: 'small steady footprint, trust the LWMA to self-correct',
      avoidMult: 0.4, strandedBoost: 2, cooldown: 6, budget: 220, counterWeight: 0.35,
    },
  };

  let enabled = false;
  let api = null;              // { applyHashrates(alloc), log(text, kind) }
  let base = null;             // snapshot at round start
  let lastActHeight = -99;
  let lastAttackKey = '';
  let currentAlloc = null;
  let profile = PROFILES.balanced;
  let profileId = 'balanced';
  let roundKey = null;         // "<challengeId>::<variantId>" for the active round

  function init(hooks) { api = hooks; }

  // --- Memory (persists across sessions in this browser) ---

  function loadMemory() {
    try { return JSON.parse(localStorage.getItem(MEMORY_KEY)) || {}; }
    catch { return {}; }
  }

  function saveMemory(memory) {
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); }
    catch { /* storage unavailable — agent still plays, just doesn't remember */ }
  }

  function memoryFor(key) {
    const memory = loadMemory();
    if (!memory[key]) memory[key] = { plays: 0, profiles: {}, lessons: [] };
    return { memory, entry: memory[key] };
  }

  function profileStats(entry, id) {
    if (!entry.profiles[id]) entry.profiles[id] = { plays: 0, wins: 0, stabilitySum: 0 };
    return entry.profiles[id];
  }

  function pickProfile(entry) {
    const tried = Object.entries(entry.profiles).filter(([, s]) => s.plays > 0);
    const untried = Object.keys(PROFILES).filter((id) => !entry.profiles[id]?.plays);

    if (!tried.length) {
      return { id: 'balanced', why: 'no memory of this challenge/config combo yet — starting BALANCED to gather a baseline' };
    }
    // Prefer trying every profile once before exploiting — always, if nothing
    // has won yet; otherwise half the time.
    const nothingWon = tried.every(([, s]) => s.wins === 0);
    if (untried.length && (nothingWon || Math.random() < 0.5)) {
      const id = untried[0];
      const why = nothingWon
        ? `nothing I've tried here has won yet, so I'm switching to untested ${PROFILES[id].label}`
        : `I have not tried ${PROFILES[id].label} on this combo yet — testing it to complete my map`;
      return { id, why };
    }
    // Epsilon-greedy: usually exploit the best, sometimes re-test an alternative.
    const scored = tried.map(([id, s]) => ({
      id,
      score: (s.wins / s.plays) + 0.3 * (s.stabilitySum / s.plays),
      record: `${s.wins}/${s.plays} wins, avg stability ${Math.round((s.stabilitySum / s.plays) * 100)}%`,
    })).sort((a, b) => b.score - a.score);

    if (Math.random() < EXPLORE_RATE && scored.length > 1) {
      const alt = scored[1 + Math.floor(Math.random() * (scored.length - 1))];
      return { id: alt.id, why: `exploring — re-testing ${PROFILES[alt.id].label} (${alt.record}) to make sure my ranking still holds` };
    }
    const best = scored[0];
    return { id: best.id, why: `memory says ${PROFILES[best.id].label} performs best here (${best.record})` };
  }

  function composeLesson(result, usedProfileId) {
    const p = PROFILES[usedProfileId];
    const stability = Math.round((result.stability || 0) * 100);
    if (result.success) {
      return `${p.label} held (stability ${stability}%, mean BT ${result.meanBt}s). Keep: ${p.desc}.`;
    }
    const hot = (result.meanBt || 120) < 100;
    const diagnosis = hot
      ? 'the chain ran hot — my counter-shrink was not enough'
      : 'blocks stalled — stranded difficulty needed more of my hash sooner';
    return `${p.label} failed (stability ${stability}%, mean BT ${result.meanBt}s) — ${diagnosis}.`;
  }

  function setEnabled(on, state) {
    enabled = on;
    if (!api) return;
    if (on) {
      api.log('Autopilot engaged. I will manage your rigs and explain every move here.', 'sys');
      if (state?.running) {
        base = null; // re-baseline mid-round from the next block
        api.log('Joining a round already in progress — I need one block of telemetry to read the field, then I will act.', 'sys');
      }
    } else {
      api.log('Autopilot disengaged — sliders are yours.', 'sys');
    }
  }

  function isEnabled() { return enabled; }

  function onBrief(challenge, state) {
    base = null;
    lastActHeight = -99;
    lastAttackKey = '';
    if (!enabled || !api) return;

    // Consult memory of past rounds on this challenge + config combo.
    roundKey = `${challenge.id}::${challenge.variantId}`;
    const { entry } = memoryFor(roundKey);
    const choice = pickProfile(entry);
    profileId = choice.id;
    profile = PROFILES[profileId];

    if (entry.plays > 0) {
      api.log(`Memory check: I have played ${challenge.name} under this config ${entry.plays} time${entry.plays === 1 ? '' : 's'} before. ${entry.lessons.length ? `Last lesson: ${entry.lessons[entry.lessons.length - 1]}` : ''}`, 'sys');
    }
    api.log(`Strategy: ${profile.label} (${profile.desc}) — ${choice.why}.`, 'plan');

    const parts = [`Mission accepted: ${challenge.name} under ${challenge.variantLabel}.`];
    if (challenge.variantId === 'lwma90') {
      parts.push('No TIP-004 penalty this round and a slow LWMA-90 window — the network will be sluggish to self-correct, so my counter-moves matter more.');
    } else {
      parts.push('TIP-004 penalty is live and the LWMA-45 window adapts fast — I will avoid streaky algos and let the penalty punish the attacker.');
    }
    switch (challenge.id) {
      case 'flood':
        parts.push('Expecting a single-algo hash flood. Opening with a spread so I can shift away from the flooded lane the moment it hits.');
        break;
      case 'hopper':
        parts.push('Expecting an algo-hopping attacker. My plan: keep boosting whichever lanes it abandons to hold every algo\u2019s share below the limit.');
        break;
      case 'whiplash':
        parts.push('Expecting burst waves on one algo. I will lean against each wave: back off while it mines, refill the crater when it vanishes.');
        break;
      default:
        parts.push('No scripted attacker — my job is simply to keep block production smooth while everyone chases points.');
    }
    api.log(parts.join(' '), 'plan');

    // Opening stance: even spread hedges against an unknown target.
    const opening = { 0: 30, 1: 30, 2: 30, 3: 30 };
    applyAlloc(opening, 'Opening stance: 30 power on each algo — a hedge until the attacker shows their hand.');
  }

  function onBlock(state, block) {
    if (!enabled || !api || !state || !block?.telemetry) return;

    const me = (state.players || []).find((p) => p.id === state.you);
    if (!me) return;
    const mine = [0, 1, 2, 3].map((i) => Number(me.hashrates?.[i] || 0));
    const totals = [0, 1, 2, 3].map((i) => Number(state.totals?.[i] || 0));
    const others = totals.map((t, i) => Math.max(0, t - mine[i]));
    const diffs = [0, 0, 0, 0];
    const shares = [0, 0, 0, 0];
    const penalized = [false, false, false, false];
    for (const t of block.telemetry) {
      diffs[t.algo] = Number(t.difficulty);
      shares[t.algo] = t.share;
      penalized[t.algo] = (t.penaltyMultiplier || 1) > 1;
    }

    if (!base) {
      base = {
        others: others.slice(),
        diffs: diffs.slice(),
        networkTotal: totals.reduce((a, b) => a + b, 0),
      };
      currentAlloc = mine.slice();
      return;
    }

    // --- Read the field ---
    const surges = others.map((o, i) => o - base.others[i]);
    const attacked = surges.map((s) => s > SURGE_THRESHOLD);
    const stranded = surges.map((s, i) =>
      s < 40 && base.diffs[i] > 0 && diffs[i] / base.diffs[i] > 1.6);
    const attackKey = attacked.map((a, i) => (a ? 1 : 0) + (stranded[i] ? 2 : 0)).join('');
    const objective = state.objective;

    // Announce attack transitions even between moves.
    if (attackKey !== lastAttackKey) {
      for (let i = 0; i < 4; i++) {
        const wasAttacked = lastAttackKey[i] === '1' || lastAttackKey[i] === '3';
        if (attacked[i] && !wasAttacked) {
          api.log(`Block ${block.height}: hostile surge detected — outside power on ${ALGO[i]} jumped +${Math.round(surges[i])}. That lane will run hot until its difficulty catches up.`, 'alert');
        }
        if (!attacked[i] && wasAttacked && stranded[i]) {
          api.log(`Block ${block.height}: the attacker left ${ALGO[i]} with difficulty stranded at ${(diffs[i] / base.diffs[i]).toFixed(1)}x baseline — blocks there will stall without help.`, 'alert');
        }
      }
    }

    const mustAct = attackKey !== lastAttackKey;
    lastAttackKey = attackKey;
    if (!mustAct && block.height - lastActHeight < profile.cooldown) return;

    // --- Decide allocation weights ---
    const reasons = [];
    const weights = [1, 1, 1, 1];

    if (objective?.type === 'dominance') {
      for (let i = 0; i < 4; i++) weights[i] = 1 / Math.max(shares[i], 0.06);
      const top = shares.indexOf(Math.max(...shares));
      reasons.push(`objective is dominance (${objective.label.toLowerCase()}), so I weight power toward the weakest lanes to dilute ${ALGO[top]}`);
    }
    for (let i = 0; i < 4; i++) {
      if (attacked[i]) {
        weights[i] *= profile.avoidMult;
        reasons.push(`staying off ${ALGO[i]} — feeding an attacked lane speeds it up further and risks penalty streaks`);
      }
      if (stranded[i]) {
        weights[i] *= profile.strandedBoost;
        reasons.push(`heavy power to ${ALGO[i]} to grind its stranded difficulty back down`);
      }
      if (penalized[i]) {
        weights[i] *= 0.3;
        reasons.push(`easing off ${ALGO[i]} while TIP-004 has it penalized`);
      }
    }

    // --- Decide total power ---
    const othersTotal = others.reduce((a, b) => a + b, 0);
    let targetTotal;
    if (objective?.type === 'dominance') {
      const surgeTotal = Math.max(0, othersTotal - (base.networkTotal - 100));
      targetTotal = clamp(100 + surgeTotal * profile.counterWeight, 100, profile.budget);
      if (surgeTotal > SURGE_THRESHOLD) {
        reasons.push(`raising my total to ${Math.round(targetTotal)} to counter-weight the attacker\u2019s share`);
      }
    } else {
      // Stability: keep total network power near its baseline.
      targetTotal = clamp(base.networkTotal - othersTotal, 40, profile.budget);
      const delta = othersTotal - (base.networkTotal - sum(currentAlloc || mine));
      if (delta > SURGE_THRESHOLD) {
        reasons.push(`outside power is +${Math.round(delta)} over baseline, so I shrink my footprint to slow total block production${targetTotal <= 60 ? ' (I can only offset so much — the LWMA must do the rest)' : ''}`);
      } else if (delta < -SURGE_THRESHOLD) {
        reasons.push(`outside power collapsed ${Math.round(delta)}, so I expand to ${Math.round(targetTotal)} to keep blocks flowing`);
      }
    }

    // --- Build allocation ---
    const wSum = weights.reduce((a, b) => a + b, 0);
    const alloc = {};
    for (let i = 0; i < 4; i++) {
      alloc[i] = Math.round((targetTotal * weights[i] / wSum) / STEP) * STEP;
      alloc[i] = Math.min(PER_ALGO_MAX, Math.max(0, alloc[i]));
    }

    const changed = [0, 1, 2, 3].reduce((acc, i) => acc + Math.abs((alloc[i] || 0) - (currentAlloc?.[i] ?? mine[i])), 0);
    if (changed < 40) return;

    const objNote = objective ? ` [${objective.label.toLowerCase()}${objective.ok ? ' — on track' : ' — FAILING'}]` : '';
    const desc = `Block ${block.height}: reallocating to ${[0, 1, 2, 3].map((i) => `${ALGO[i]} ${alloc[i]}`).join(' · ')}${objNote}. ${sentence(reasons)}`;
    applyAlloc(alloc, desc);
    lastActHeight = block.height;
  }

  function onResult(result) {
    if (!enabled || !api || !result) return;
    const verdict = result.success
      ? 'We held the network — objective met.'
      : 'We lost this one — the objective slipped away.';
    api.log(`${verdict} Final read: stability ${Math.round((result.stability || 0) * 100)}%, mean block time ${result.meanBt}s vs 120s target, top algo peaked at ${Math.round((result.maxShare || 0) * 100)}%, ${result.penaltyEvents} TIP-004 penalties. This datapoint was recorded under "${result.challenge?.variantLabel}".`, result.success ? 'plan' : 'alert');

    // Postmortem: update memory so the next round on this combo starts smarter.
    if (!roundKey) return;
    const { memory, entry } = memoryFor(roundKey);
    entry.plays += 1;
    const stats = profileStats(entry, profileId);
    stats.plays += 1;
    if (result.success) stats.wins += 1;
    stats.stabilitySum += result.stability || 0;

    const lesson = composeLesson(result, profileId);
    entry.lessons.push(lesson);
    if (entry.lessons.length > 5) entry.lessons.shift();
    saveMemory(memory);

    const record = `${stats.wins}/${stats.plays}`;
    api.log(`Postmortem saved: "${lesson}" ${PROFILES[profileId].label} is now ${record} on this combo. I'll use this next time the same challenge and config come up.`, 'sys');
    roundKey = null;
  }

  /** Human-readable summary of everything learned so far. */
  function memoryReport() {
    const memory = loadMemory();
    const keys = Object.keys(memory);
    if (!keys.length) return 'Memory is empty — no completed rounds yet.';
    return keys.map((key) => {
      const [challenge, variant] = key.split('::');
      const entry = memory[key];
      const profiles = Object.entries(entry.profiles)
        .filter(([, s]) => s.plays > 0)
        .map(([id, s]) => `${PROFILES[id].label} ${s.wins}/${s.plays}`)
        .join(', ');
      return `${challenge.toUpperCase()} @ ${variant}: ${entry.plays} plays — ${profiles || 'none'}`;
    }).join('\n');
  }

  function applyAlloc(alloc, narration) {
    currentAlloc = [0, 1, 2, 3].map((i) => alloc[i] || 0);
    api.applyHashrates(alloc);
    api.log(narration, 'move');
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
  function sentence(reasons) {
    if (!reasons.length) return 'Routine rebalance to stay aligned with the objective.';
    const unique = [...new Set(reasons)];
    return unique[0].charAt(0).toUpperCase() + unique.join('; ').slice(1) + '.';
  }

  return { init, setEnabled, isEnabled, onBrief, onBlock, onResult, memoryReport };
})();

if (typeof window !== 'undefined') window.Copilot = Copilot;
