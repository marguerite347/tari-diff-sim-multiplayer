# AGENTS.md

Guidance for AI coding agents contributing to this repo. Human-facing docs: [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Task recipes for common contributions live in [skills/](skills/).

> **Heads up:** heavy feature work is often in flight on this repo. File details below may drift — always read the actual source before editing, and re-read any file another change may have touched.

## What this project is

A community **research game**: a Node/Express + WebSocket multiplayer "network defense" game simulating Tari's multi-algorithm LWMA difficulty adjustment. Players join a shared room and allocate hashrate across four PoW algorithms on a 3D battlefield while scripted bot attacks (hash floods, algo-hopping, selfish mining, etc.) stress the chain. Each round randomly draws one of two network configurations — status quo (LWMA-90, no penalty) vs. proposed (LWMA-45 + TIP-004 penalty) — and the objective outcome is recorded as a research datapoint. The aggregate at `/api/research` compares how the two configs hold up under identical attacks. **The research data is the point; game features exist to generate it.**

## Architecture map

| File | What it does |
|---|---|
| `server/index.js` | Express static server + WebSocket endpoint (`/ws`), message routing, `/api/research` and `/health` |
| `server/engine.js` | Server-side LWMA + mining race: `LwmaWindow`, `computeAlgoRates`, `mineOneBlock`, orphan sampling, `mulberry32` PRNG |
| `server/room.js` | `Room`/`RoomManager`: game loop (`scheduleNext`), challenge arming, bot schedules, scoring, shadow-miner reorgs (`_shadowStep`, `_revealShadow`) |
| `server/challenges.js` | Challenge ("level") factories, `VARIANTS` (network configs under test), `ObjectiveTracker` scoring |
| `server/research.js` | Appends round results to `data/rounds.jsonl` (`recordRound`), aggregates per challenge×variant (`aggregate`) |
| `index.html` | Single page: solo simulator tabs + the multiplayer game; loads all scripts (no build step) |
| `js/multiplayer.js` | Multiplayer client: WebSocket handling, HUD, sliders, leaderboard, ticker narration, telemetry charts |
| `js/battlefield.js` | Three.js 3D battlefield: armies, difficulty walls, invaders, block tower, reorg/orphan effects, skyboxes |
| `js/agent.js` | "Copilot" heuristic autopilot: strategy profiles, localStorage memory, narrated decisions |
| `js/lwma.js`, `js/simulation.js`, `js/prng.js`, `js/statistics.js`, `js/validation.js`, `js/charts.js`, `js/app.js`, `js/config.js` | The original **solo** simulator (client-side LWMA, validation against mainnet); largely independent of multiplayer |
| `js/data.js` | Real Tari mainnet block snapshot (one giant line — don't open/edit casually) |
| `css/style.css` | All styling, including the `mp-` prefixed multiplayer/arcade classes |
| `lib/` | Vendored `three.min.js` (r149) and `chart.min.js` — no package manager for client libs |
| `data/rounds.jsonl` | Research output (gitignored — never commit) |
| `assets/skyboxes/` | ~1.6 GB of skybox images + `manifest.json` (untracked — never commit) |

## Run locally

```bash
npm install
npm start          # node server/index.js, listens on http://localhost:8787
```

Open http://localhost:8787 → **Multiplayer** tab → **Create room** → **Start**. Requires Node ≥ 18. There is no build step, no bundler, no test suite — verification is running the game.

## How to verify changes

- **Server edits** (`server/**`): restart the server (no hot reload), then play a round.
- **Client edits** (`js/**`, `css/**`, `index.html`): files are served statically — just refresh the browser.
- **Play a full round**: create a room, hit Start, let the round finish (~1–2 min at default speedup), and confirm the result card, `/api/research` aggregation, and a new line in `data/rounds.jsonl`.
- **Debug env hooks**:
  - `FORCE_CHALLENGE=<id> npm start` pins the challenge draw (ids: `flood`, `hopper`, `whiplash`, `shadow`, `goldrush`) — see `drawChallenge` in `server/challenges.js`.
  - `ORPHAN_WINDOW=60 npm start` makes depth-1 orphans frequent (default 8 sim-seconds) — see `server/engine.js`.
- Increase the host's **speedup** setting in-game to make rounds finish faster while testing.

## Simulation invariants — never break these

1. **The LWMA feedback loop must stay live.** Solve rate is `rate = hashrate / targetDifficulty` (`computeAlgoRates` in `server/engine.js`). Power shifts must change difficulty via the window, which changes rates. Never short-circuit this with fixed block times or fixed winners.
2. **120-second overall block target.** Four algos each with a 480s per-algo `targetTime` (`ALGO_CONFIG`), giving 120s combined when all run. `TARGET_BT = 120` in `server/challenges.js` scores against this.
3. **Equilibrium seeding.** Every challenge round starts with `seedWindowsForPower` re-seeding each algo window to the difficulty that puts the opening power mix at equilibrium, so scores measure attack response, not warm-up drift. Anything that changes starting conditions must preserve this.
4. **Reproducible PRNG.** All round randomness flows through the room's `mulberry32` instance (`this.rng`). Don't introduce `Math.random()` into simulation logic (UI/cosmetic use is fine).
5. **`LwmaWindow.calculate` is an exact port of Tari's Rust LWMA** (BigInt integer math, clamps, weighting). Do not "clean up" or float-ify it. Same for the client copy in `js/lwma.js`.
6. **Research data schema stability.** The fields written by `recordRound` (in `Room.finishChallenge`) and consumed by `aggregate()` in `server/research.js` are a stable schema: `data/rounds.jsonl` is append-only and old lines must keep aggregating correctly. Add new fields freely; never rename, repurpose, or change the meaning of existing ones. Never reuse an existing challenge or variant `id`.
7. **Network verdict and personal score are separate.** `ObjectiveTracker.evaluate()` alone decides whether the room defended the network. Player points, streaks, and MVP reward mined blocks but must never override or be presented as the round verdict.

## Code style

- Plain JavaScript. No frameworks, no TypeScript, no build step. Server uses CommonJS (`require`); client files are IIFE modules attached to `window` (e.g. `window.Battlefield`) and loaded via `<script>` tags in `index.html`.
- `'use strict';` at the top of every file. 2-space indent, single quotes, semicolons.
- Client libs are vendored in `lib/` — don't add npm packages for the client. Server deps are just `express` and `ws`; think hard before adding more.
- **Arcade UI copy is UPPERCASE** — ticker lines, toasts, objective labels, challenge names/briefs follow the existing style (`HASH FLOOD`, `NETWORK DEFENDED`, `ENEMY INBOUND — …`).
- Comments explain non-obvious intent or simulation math, not what the code does.

## PR expectations

- Small, focused diffs. One feature or fix per PR. Don't reformat or refactor code you're not changing.
- Verify in the browser before opening a PR — actually play a round exercising your change, and say in the PR what you tested (including which `FORCE_CHALLENGE` if relevant).
- **Never commit** `data/` (gitignored research output) or `assets/skyboxes/` (~1.6 GB, untracked). Check `git status` before staging.
- If you touch the round-result schema or challenge/variant ids, call it out prominently — it affects everyone's collected research data.
- Follow the task recipes in `skills/` when your change matches one (new challenge, new variant, battlefield visual, Copilot tuning).
