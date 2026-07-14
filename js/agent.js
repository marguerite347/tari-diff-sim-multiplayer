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
  const TOTAL_BUDGET = 400;    // self-imposed cap so the agent stays "one player"
  const SURGE_THRESHOLD = 120; // outside power delta that reads as an attack
  const ACT_COOLDOWN = 4;      // min blocks between reallocation moves

  let enabled = false;
  let api = null;              // { applyHashrates(alloc), log(text, kind) }
  let base = null;             // snapshot at round start
  let lastActHeight = -99;
  let lastAttackKey = '';
  let currentAlloc = null;

  function init(hooks) { api = hooks; }

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
    if (!mustAct && block.height - lastActHeight < ACT_COOLDOWN) return;

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
        weights[i] *= 0.15;
        reasons.push(`staying off ${ALGO[i]} — feeding an attacked lane speeds it up further and risks penalty streaks`);
      }
      if (stranded[i]) {
        weights[i] *= 3;
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
      targetTotal = clamp(100 + surgeTotal * 0.7, 100, TOTAL_BUDGET);
      if (surgeTotal > SURGE_THRESHOLD) {
        reasons.push(`raising my total to ${Math.round(targetTotal)} to counter-weight the attacker\u2019s share`);
      }
    } else {
      // Stability: keep total network power near its baseline.
      targetTotal = clamp(base.networkTotal - othersTotal, 40, TOTAL_BUDGET);
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

  return { init, setEnabled, isEnabled, onBrief, onBlock, onResult };
})();

if (typeof window !== 'undefined') window.Copilot = Copilot;
