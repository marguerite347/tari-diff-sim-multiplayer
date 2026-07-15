---
name: tune-copilot-strategy
description: Tune or extend the Copilot autopilot in js/agent.js — strategy profiles, per-challenge tactics, localStorage memory, and narrated decision logs. Use when asked to improve the autopilot, add a strategy, or change how the agent reasons or narrates.
---

# Tune the Copilot (autopilot) strategy

`js/agent.js` is a heuristic agent that plays a player's sliders and **narrates every decision** to the decision log. It reads only what a human sees: `state.totals`, leaderboard hashrates, per-block `telemetry` (difficulty/share/penalty per algo), and the round `objective`. It's an IIFE exposing `window.Copilot`; `js/multiplayer.js` wires it up via `Copilot.init({ applyHashrates, log })` and calls the lifecycle hooks.

**Read `js/agent.js` first** — details may have drifted.

## Architecture

- **Lifecycle hooks**: `onBrief(challenge, state)` (round start: pick profile, announce plan, set opening stance), `onBlock(state, block)` (per-block sense→decide→act), `onShadow` / `onReorg` (event reactions), `onResult(result)` (postmortem: update memory).
- **Strategy profiles** (`PROFILES`): named tunable bundles — `balanced`, `hardCounter`, `lightTouch` — each with `avoidMult` (weight multiplier for attacked lanes), `strandedBoost` (weight for stranded-difficulty lanes), `cooldown` (blocks between moves), `budget` (max total power), `counterWeight` (how hard to match attacker surges).
- **Sensing** in `onBlock`: a first-block baseline (`base`) of outside power and difficulty per lane, then `surges` (outside power − baseline, attack if > `SURGE_THRESHOLD`), `stranded` (difficulty > 1.6× baseline with the lane abandoned), and `penalized` flags. Changes to `attackKey` force an immediate move; otherwise moves respect `profile.cooldown`.
- **Deciding**: per-lane `weights` shaped by the objective type (`dominance` → inverse-share, `reorg` → 3.5× on the shadow lane, attacked ×`avoidMult`, stranded ×`strandedBoost`, penalized ×0.3) and a `targetTotal` power budget; the result rounds to `STEP` (10), clamps at `PER_ALGO_MAX` (300), and moves < 40 total power change are skipped.
- **Memory** (`localStorage`, key `copilotMemory.v1`): keyed by `"<challengeId>::<variantId>"`, tracking per-profile `{plays, wins, stabilitySum}` plus up to 5 `lessons`. `pickProfile` is epsilon-greedy (`EXPLORE_RATE = 0.25`, untried-first). `onResult` updates stats and composes a lesson (`composeLesson`). Bump the `MEMORY_KEY` version only if you change the stored shape incompatibly.

## Narration conventions

Every action gets a log line via `api.log(text, kind)` with kinds `'sys'` (status/memory), `'plan'` (strategy/intent), `'move'` (allocations — emitted by `applyAlloc`), `'alert'` (attacks, reorgs, orphans). Style is first-person, sentence case (not the HUD's UPPERCASE), and **explains the why**: cite the numbers the decision used ("outside power on Sha3x jumped +480"). Always pair a slider change with narration — use `applyAlloc(alloc, narration)`, never `api.applyHashrates` directly.

## Common tasks

- **Tune a profile**: adjust its numbers; the memory system will re-rank profiles as rounds accumulate.
- **Add a profile**: add to `PROFILES` with `label`/`desc` + the five tunables. `pickProfile` and `memoryReport` handle it automatically; old memory entries simply have no stats for it yet.
- **Add a per-challenge tactic**: extend the `switch (challenge.id)` in `onBrief` (plan announcement + opening stance) and, if it needs per-block behavior, the weight logic in `onBlock`. New challenges fall into the `default` branch until you do.
- **React to a new event**: add an `onX` hook, export it in the return object, and call it from the matching case in `handleServerMessage` in `js/multiplayer.js` (guarded: `Copilot.onX?.(…)`).

## Verify

1. `npm start`, open http://localhost:8787, create a room — autopilot engages by default (`engageCopilotByDefault` in `multiplayer.js`).
2. Pin the relevant challenge (`FORCE_CHALLENGE=hopper npm start`) and watch the decision log: the plan should match the brief, moves should cite real observations, and slider positions should track the narration.
3. Play the same combo 3–4 rounds, then click the memory button (`mpCopilotMemory`): the report should show plays/wins accumulating and profile selection reacting ("memory says HARD COUNTER performs best here").
4. Sanity-check win rate: the Copilot should usually beat an idle player on the challenge you tuned. DevTools → `localStorage.removeItem('copilotMemory.v1')` resets memory between experiments.
