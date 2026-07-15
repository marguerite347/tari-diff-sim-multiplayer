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

  // --- LLM advisory layer (optional, via window.LLMBridge) ---
  // The heuristics above stay the always-on reflex layer; when the bridge is
  // active the model is consulted at a few key moments (~3-6 calls/round) and
  // its validated guidance is BLENDED into — never substituted for — the
  // heuristic decision. All safety rails (per-algo max, budget, step
  // rounding) apply unchanged.
  const LLM_MAX_TACTICAL_CALLS = 4;
  let llmGuidance = null;      // last validated {weights,totalPower} advice
  let llmTacticalCalls = 0;
  let lastField = null;        // compact field summary for tactical prompts

  function init(hooks) { api = hooks; }

  function llmActive() {
    return typeof window !== 'undefined' && window.LLMBridge?.isActive();
  }

  function llmSystemPrompt() {
    return [
      'You are the strategy brain of a mining copilot in a Tari network defense game.',
      'The network has 4 proof-of-work algos: RandomXM(0), Sha3x(1), RandomXT(2), Cuckaroo(3). Each algo has its own LWMA difficulty that adapts to the hashrate pointed at it: more hash -> difficulty rises -> that lane slows; hash leaving a lane strands its difficulty high and blocks stall there. Network target is one block every 120s across all algos. TIP-004 (when active) penalizes an algo that wins several blocks in a row by multiplying its difficulty.',
      'Objective types: "stability" = keep mean block time near 120s; "dominance" = keep every single algo\'s share of recent blocks below a limit; "reorg" = a shadow miner builds a hidden chain on one algo — keep that algo\'s difficulty high to starve it and prevent a reorg.',
      'A scripted attacker adds/removes outside hashrate. Good play: avoid pouring hash into attacked (surging) lanes, refill lanes with stranded difficulty, dilute a dominant algo by boosting the weak ones.',
      'Your player controls 4 rigs, 0-300 power each (steps of 10), sensible total 40-400.',
      'Respond with STRICT JSON only, no prose, exactly this shape:',
      '{"weights":[w0,w1,w2,w3],"totalPower":n,"profileBias":"hardCounter|balanced|lightTouch","say":"one short paragraph of in-character tactical narration"}',
      'weights are relative allocation across the 4 algos (any positive numbers, they get normalized). totalPower is your suggested total (40-400). profileBias picks the reflex layer\'s aggression. say is what you tell the pilot.',
    ].join('\n');
  }

  function llmNarrate(say) {
    if (say) api.log(`[LLM] ${say}`, 'llm');
  }

  /** Brief-time consultation: strategy guidance from challenge + memory. */
  function llmConsultBrief(challenge, entry) {
    const key = roundKey;
    const memLines = Object.entries(entry.profiles || {})
      .filter(([, s]) => s.plays > 0)
      .map(([id, s]) => `${id}: ${s.wins}/${s.plays} wins, avg stability ${s.plays ? Math.round((s.stabilitySum / s.plays) * 100) : 0}%`);
    const prompt = [
      `New round. Challenge: ${challenge.name} (id ${challenge.id}). Config: ${challenge.variantLabel} (${challenge.variantId === 'lwma90' ? 'slow LWMA-90 window, NO TIP-004 penalty' : 'fast LWMA-45 window, TIP-004 penalty active'}).`,
      challenge.shadowAlgo != null ? `Shadow miner targets algo ${challenge.shadowAlgo}.` : '',
      memLines.length ? `My memory on this exact challenge+config (${entry.plays} past plays):\n${memLines.join('\n')}` : 'No memory of this challenge+config yet.',
      entry.lessons?.length ? `Lessons from past rounds:\n${entry.lessons.join('\n')}` : '',
      'Give me opening guidance as strict JSON per the contract.',
    ].filter(Boolean).join('\n');

    window.LLMBridge.requestGuidance(llmSystemPrompt(), prompt).then((g) => {
      if (!g || !enabled || roundKey !== key) return; // stale or round over — drop silently
      if (g.profileBias && PROFILES[g.profileBias]) {
        profileId = g.profileBias;
        profile = PROFILES[profileId];
        api.log(`[LLM] Advisor overrides profile to ${profile.label} for this round.`, 'llm');
      }
      if (g.weights || g.totalPower != null) {
        llmGuidance = { weights: g.weights, totalPower: g.totalPower };
      }
      llmNarrate(g.say);
    });
  }

  /** Tactical consultation on major attack transitions (budget-capped). */
  function llmConsultTactical(reason) {
    if (!llmActive() || llmTacticalCalls >= LLM_MAX_TACTICAL_CALLS || !lastField) return;
    llmTacticalCalls += 1;
    const key = roundKey;
    const f = lastField;
    const prompt = [
      `Mid-round update at block ${f.height}: ${reason}`,
      `Objective: ${f.objective || 'none'}${f.objectiveOk === false ? ' (currently FAILING)' : ''}.`,
      `Per-algo outside power surge vs round baseline: [${f.surges.join(', ')}].`,
      `Attacked lanes: [${f.attacked.join(', ')}]. Stranded-difficulty lanes: [${f.stranded.join(', ')}]. TIP-004-penalized lanes: [${f.penalized.join(', ')}].`,
      `Recent win share per algo: [${f.shares.join(', ')}]. My current allocation: [${f.mine.join(', ')}].`,
      'Update your guidance as strict JSON per the contract.',
    ].join('\n');

    window.LLMBridge.requestGuidance(llmSystemPrompt(), prompt).then((g) => {
      if (!g || !enabled || roundKey !== key) return;
      if (g.weights || g.totalPower != null) {
        llmGuidance = { weights: g.weights, totalPower: g.totalPower };
      }
      llmNarrate(g.say);
    });
  }

  /** Round-end consultation: ask the model to write the stored lesson. */
  function llmConsultPostmortem(result, usedProfileId, key) {
    const prompt = [
      `Round over: ${result.success ? 'WON' : 'LOST'}. Profile used: ${usedProfileId}.`,
      `Stats: stability ${Math.round((result.stability || 0) * 100)}%, mean block time ${result.meanBt}s (target 120s), top algo share ${Math.round((result.maxShare || 0) * 100)}%, ${result.penaltyEvents} TIP-004 penalties. Config: ${result.challenge?.variantLabel}.`,
      'Write a one-sentence lesson for my memory in "say" (what to keep or change next time on this challenge). Strict JSON per the contract; weights/totalPower/profileBias may be null.',
    ].join('\n');

    window.LLMBridge.requestGuidance(llmSystemPrompt(), prompt).then((g) => {
      if (!g?.say) return;
      const lesson = `[LLM] ${g.say.slice(0, 240)}`;
      const { memory, entry } = memoryFor(key);
      entry.lessons.push(lesson);
      if (entry.lessons.length > 5) entry.lessons.shift();
      saveMemory(memory);
      llmNarrate(`Postmortem lesson saved: ${g.say.slice(0, 240)}`);
    });
  }

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
    llmGuidance = null;
    llmTacticalCalls = 0;
    lastField = null;
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

    // Optional LLM consultation (async — heuristic plan above stands until
    // validated guidance arrives; on any failure nothing changes).
    if (llmActive()) llmConsultBrief(challenge, entry);

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
      case 'shadow':
        parts.push(`A selfish miner is building a hidden ${ALGO[challenge.shadowAlgo] ?? ''} chain. My plan: pile hash onto that lane to drive its difficulty up and starve the hidden rig, while keeping the other lanes alive so no reorg window opens.`);
        break;
      default:
        parts.push('No scripted attacker — my job is simply to keep block production smooth while everyone chases points.');
    }
    api.log(parts.join(' '), 'plan');

    // Opening stance: even spread hedges against an unknown target — except
    // against a shadow miner, where the counter is loading its lane early.
    if (challenge.id === 'shadow' && challenge.shadowAlgo != null) {
      const opening = { 0: 25, 1: 25, 2: 25, 3: 25 };
      opening[challenge.shadowAlgo] = 150;
      applyAlloc(opening, `Opening stance: 150 power on ${ALGO[challenge.shadowAlgo]} to inflate its difficulty before the hidden rig gets traction, 25 everywhere else to deny streaks.`);
    } else {
      const opening = { 0: 30, 1: 30, 2: 30, 3: 30 };
      applyAlloc(opening, 'Opening stance: 30 power on each algo — a hedge until the attacker shows their hand.');
    }
  }

  function onBlock(state, block) {
    if (!enabled || !api || !state || !block?.telemetry) return;

    if (block.orphan?.minerId === state.you) {
      api.log(`Tough luck: our ${ALGO[block.orphan.algo]} block was found almost simultaneously with the winner and got orphaned — no points, that's just propagation physics. Strategy unchanged.`, 'alert');
    }

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

    // Keep a compact field summary for LLM tactical prompts.
    lastField = {
      height: block.height,
      objective: objective ? `${objective.type} (${objective.label})` : null,
      objectiveOk: objective?.ok,
      surges: surges.map((s) => Math.round(s)),
      attacked: attacked.map((a, i) => (a ? ALGO[i] : null)).filter(Boolean),
      stranded: stranded.map((s, i) => (s ? ALGO[i] : null)).filter(Boolean),
      penalized: penalized.map((p, i) => (p ? ALGO[i] : null)).filter(Boolean),
      shares: shares.map((s) => `${Math.round(s * 100)}%`),
      mine: mine,
    };

    const mustAct = attackKey !== lastAttackKey;
    if (mustAct && lastAttackKey !== '' && llmActive()) {
      llmConsultTactical('the attack pattern just shifted (surge appeared/vanished or a lane went stranded)');
    }
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
    const shadowAlgo = state.challenge?.shadowAlgo;
    if (objective?.type === 'reorg' && shadowAlgo != null) {
      weights[shadowAlgo] *= 3.5;
      reasons.push(`keeping ${ALGO[shadowAlgo]} difficulty inflated — every point of difficulty there slows the hidden chain`);
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

    // --- Blend in LLM guidance (advisory only — rails still apply) ---
    let finalWeights = weights;
    if (llmGuidance) {
      if (llmGuidance.weights) {
        const hSum = weights.reduce((a, b) => a + b, 0);
        finalWeights = weights.map((w, i) => 0.5 * (w / hSum) + 0.5 * llmGuidance.weights[i]);
        reasons.push('blending in the LLM advisor\u2019s lane weighting');
      }
      if (llmGuidance.totalPower != null) {
        targetTotal = clamp((targetTotal + llmGuidance.totalPower) / 2, 40, profile.budget);
      }
    }

    // --- Build allocation ---
    const wSum = finalWeights.reduce((a, b) => a + b, 0);
    const alloc = {};
    for (let i = 0; i < 4; i++) {
      alloc[i] = Math.round((targetTotal * finalWeights[i] / wSum) / STEP) * STEP;
      alloc[i] = Math.min(PER_ALGO_MAX, Math.max(0, alloc[i]));
    }

    const changed = [0, 1, 2, 3].reduce((acc, i) => acc + Math.abs((alloc[i] || 0) - (currentAlloc?.[i] ?? mine[i])), 0);
    if (changed < 40) return;

    const objNote = objective ? ` [${objective.label.toLowerCase()}${objective.ok ? ' — on track' : ' — FAILING'}]` : '';
    const desc = `Block ${block.height}: reallocating to ${[0, 1, 2, 3].map((i) => `${ALGO[i]} ${alloc[i]}`).join(' · ')}${objNote}. ${sentence(reasons)}`;
    applyAlloc(alloc, desc);
    lastActHeight = block.height;
  }

  /** Narration for orphan/shadow events (also fires when autopilot is on mid-round). */
  function onShadow(state, msg) {
    if (!enabled || !api) return;
    if (msg.fizzled) {
      api.log('The shadow miner abandoned its hidden chain — our difficulty wall on that lane starved it out. Holding position until the round ends.', 'plan');
      return;
    }
    if (msg.stale) {
      api.log(`Good sign: the honest chain out-paced the hidden rig — its stack slipped to ${msg.count}. The pressure on ${ALGO[msg.algo]} is working.`, 'plan');
      return;
    }
    const urgency = msg.count >= 2 ? ' One more and it can rewrite the chain — piling more hash onto that lane now.' : '';
    api.log(`Warning: the hidden ${ALGO[msg.algo]} chain grew to ${msg.count} block${msg.count === 1 ? '' : 's'}.${urgency}`, 'alert');
    if (msg.count >= 2 && currentAlloc && msg.algo != null) {
      const alloc = { 0: currentAlloc[0], 1: currentAlloc[1], 2: currentAlloc[2], 3: currentAlloc[3] };
      alloc[msg.algo] = Math.min(PER_ALGO_MAX, (alloc[msg.algo] || 0) + 60);
      applyAlloc(alloc, `Emergency surge: +60 power to ${ALGO[msg.algo]} to spike its difficulty while the shadow chain sits one block from reveal.`);
    }
  }

  function onReorg(state, msg) {
    if (!enabled || !api) return;
    api.log(`REORG: the shadow miner revealed ${msg.depth} hidden blocks and rewrote the chain — points on the orphaned blocks were clawed back. ${msg.depth > 2 ? 'That was a deep cut; the objective is likely lost unless we stop the next one.' : 'Still inside the objective limit — do not let it happen again.'} Re-inflating ${ALGO[msg.algo]} difficulty.`, 'alert');
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

    // Optional LLM postmortem — its lesson lands in the same memory (async).
    if (llmActive()) llmConsultPostmortem(result, profileId, roundKey);
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

  return { init, setEnabled, isEnabled, onBrief, onBlock, onResult, onShadow, onReorg, memoryReport };
})();

if (typeof window !== 'undefined') window.Copilot = Copilot;
