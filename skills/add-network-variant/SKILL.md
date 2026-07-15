---
name: add-network-variant
description: Add a candidate Tari network configuration to VARIANTS in server/challenges.js so rounds test it against the status quo. Use when asked to add a new network config, LWMA window size, penalty scheme, or research comparison arm.
---

# Add a network variant (candidate config)

The whole point of this game is comparing network configurations under identical attacks. `VARIANTS` in `server/challenges.js` holds the configs under test — currently `lwma90` (status quo: LWMA-90, no penalty) and `lwma45_tip004` (proposed: LWMA-45 + TIP-004 penalty). `drawChallenge` attaches one uniformly at random to every round.

**Read `server/challenges.js` and `server/room.js` first** — details may have drifted.

## 1. Understand what a variant controls

A variant is `{ id, label, windowSize, penalty }`:

- `windowSize` — the LWMA window (blocks). Applied in `Room._armChallenge` via `this.windowSize = this.challenge.variant.windowSize` and `createWindows`.
- `penalty` — whether the TIP-004 consecutive same-algo penalty is on. Applied as `this.penalty`, consumed by `applyPenalty` in `server/engine.js` (target time doubles per streak step, `PENALTY_BASE = 2n`).
- `label` — player-facing copy in `STATUS QUO · …` / `PROPOSED · …` style; it appears on the mission card and in research rows, and is stored in every datapoint as `variantLabel`.

These are the only knobs today. If your candidate config needs a new knob (different penalty base, per-algo windows, etc.), you must plumb it: variant field → `_armChallenge` → engine parameter — keeping the defaults exactly equivalent to current behavior for existing variants.

## 2. Add the entry

```js
{
  id: 'lwma60',                          // stable, NEVER reuse a retired id
  label: 'CANDIDATE · LWMA-60 · no penalty',
  windowSize: 60,
  penalty: false,
},
```

`id` and `label` are written into `data/rounds.jsonl` forever and become an aggregation bucket in `aggregate()` (`server/research.js`) keyed as `challenge::variant` — treat both as permanent.

## 3. Understand the research cost

Variants are drawn **uniformly**. Each addition dilutes rounds per (challenge, variant) cell: with 5 challenges and 3 variants there are 15 cells, and a credible win-rate comparison needs many rounds per cell. Only add a variant the community actually wants tested, and say so in the PR. Removing a variant later is fine (old data still aggregates); its id stays retired.

## 4. Verify

1. Restart the server; there is no env hook to force a variant, so either start rounds until yours is drawn or *temporarily* pin `challenge.variant = VARIANTS[i]` in `drawChallenge` (revert before committing).
2. Confirm the mission card shows your label, and — for window/penalty changes — that the telemetry lab charts respond plausibly (smaller window = jumpier difficulty; penalty on = `PENALTY x2` banners and frost walls on streaks).
3. Finish a round; check the new line in `data/rounds.jsonl` has your `variant`/`variantLabel` and `/api/research` shows a row for it per challenge.
4. Check `js/agent.js`: `Copilot.onBrief` special-cases `variantId === 'lwma90'` with an else-branch assuming TIP-004 — if your variant breaks that dichotomy (e.g. a no-penalty small window), update the narration so the Copilot doesn't lie about the rules.

Do not commit `data/` or `assets/skyboxes/`.
