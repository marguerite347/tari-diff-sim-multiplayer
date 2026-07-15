---
name: add-challenge
description: Add a new attack scenario ("level") to the multiplayer research game — a challenge factory in server/challenges.js with bots, schedules, an objective, and verification via FORCE_CHALLENGE. Use when asked to add a new challenge, level, attack scenario, or bot behavior.
---

# Add a new challenge (attack scenario)

A challenge is a scripted bot attack drawn at random each round. Humans defend; the round's objective result becomes one research datapoint comparing network variants. All code lives in `server/challenges.js`; the game loop that runs it is in `server/room.js`.

**Read `server/challenges.js` first** — features are frequently in flight and details here may have drifted.

Before implementation, follow `docs/challenge-proposal-process.md`. Pool inclusion requires maintainer review and seeded balance evidence across both builtin variants; opening a proposal does not change runtime behavior.

## 1. Write the factory

Add a function to the `CHALLENGE_FACTORIES` array in `server/challenges.js`. It receives the room's seeded `rng` (use it for all randomness — never `Math.random()`) and returns:

```js
function myAttack(rng) {
  const algo = Math.floor(rng() * 4);   // randomize the target lane
  return {
    id: 'myattack',                     // stable, lowercase, NEVER reuse a retired id
    name: 'MY ATTACK',                  // uppercase arcade style
    brief: 'One or two sentences telling players what is coming and what to do.',
    durationBlocks: 80,                 // round length in blocks (existing: 70–90)
    scoredFromBlock: 20,                // objective ignores blocks before this (attack lead-in)
    objective: { /* see step 3 */ },
    bots: [ /* see step 2 */ ],
  };
}
```

The drawn variant (LWMA-90 vs LWMA-45+TIP-004) is attached by `drawChallenge` — your factory must not set it.

## 2. Define bots and schedules

Each bot is `{ name, kind, schedule }`. `kind: 'attacker'` renders as red invaders on the battlefield and counts as hostile in the client's `forceBreakdown`; `kind: 'noise'` is background hash. Almost every challenge includes `noiseBot()` (30 power on each algo) so the chain doesn't stall.

A schedule is a list of phases applied by height (`Room._applyBotSchedules` picks the last phase with `at <= height`, re-applied after every block):

```js
{
  name: 'UNKNOWN RIG',
  kind: 'attacker',
  schedule: [
    { at: 0, hashrates: {} },              // idle at round start
    { at: 20, hashrates: { [algo]: 600 } }, // strike at block 20
    { at: 60, hashrates: {} },             // withdraw at block 60
  ],
}
```

Power scale: humans default to 100 total, sliders max at 300 per algo, `noiseBot` runs 30/algo. Existing attackers use 450–600 on a single algo. For a selfish-mining variant, add a `shadow: { algo, power, startAt, stopAt, revealAt, minReveal, staleAfter }` config (see `shadowMiner` and `Room._shadowStep` / `_revealShadow`).

## 3. Pick an objective

`ObjectiveTracker` supports three types (adding a type means touching `progress()`, `evaluate()`, and clients — avoid unless necessary):

- `{ type: 'stability', threshold: 0.6, label: '…' }` — trailing-15 mean block time within 0.7×–1.5× of the 120s target for ≥ threshold of scored blocks.
- `{ type: 'dominance', maxShare: 0.6, label: '…' }` — no algo exceeds `maxShare` of wins in any trailing-20 window.
- `{ type: 'reorg', maxDepth: 2, label: '…' }` — deepest shadow-miner rewrite ≤ `maxDepth` (only meaningful with a `shadow` config).

The `label` is player-facing UPPERCASE-friendly copy; it's the verdict criterion shown on the mission card, HUD race bar, and the round-result screen (via `publicChallenge().objectiveLabel`).

## 4. Check the public projection

`publicChallenge(challenge)` in `server/challenges.js` controls what clients see. If your challenge has extra fields the client must know (like `shadowAlgo`), expose them there deliberately — everything else stays server-secret.

## 5. Verify

```bash
FORCE_CHALLENGE=myattack npm start
```

(`drawChallenge` pins the draw to your id.) Then in the browser at http://localhost:8787:

1. Create a room, Start. The mission card should show your name, brief, and objective.
2. Watch the attack land: hostile troops on the right lane, difficulty wall rising, ticker narration.
3. Bump the speedup setting and let the round finish. Confirm the verdict makes sense, a new line lands in `data/rounds.jsonl`, and `/api/research` shows your challenge id.
4. Play it once trying to win and once idling — a good challenge is losable when ignored and winnable when played. Tune schedule power/timing and objective thresholds until both hold.
5. Run many recorded seeds under both `lwma90` and `lwma45_tip004`, including ignored, purposeful human, and Copilot play. Declare any timing/window hypothesis; do not tune in an undeclared structural advantage for one variant.

Do not commit `data/rounds.jsonl` (gitignored) or `assets/`.
