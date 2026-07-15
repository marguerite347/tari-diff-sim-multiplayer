# Tari Diff Sim — Block Race

Fork of [m4r1m0/tari-diff-sim](https://github.com/m4r1m0/tari-diff-sim) turned into a **community research game**: shareable multiplayer rooms where every round is a random network challenge, and every finished round becomes a datapoint comparing candidate Tari network changes against the status quo.

Players join a room and allocate hashrate across Tari's four PoW algorithms on a 3D battlefield. Each round draws:

- a random **challenge** ("level") — a scripted bot attack such as a hash flood, algo-hopping, or burst-mining whiplash, plus a no-attacker control round; and
- a random **network variant** — status quo (LWMA-90, no penalty) or the proposed change (LWMA-45 + TIP-004 penalty).

Players defend the chain with their sliders. The round is scored on objective metrics (rolling block-time stability, algo dominance), recorded to `data/rounds.jsonl`, and aggregated at `/api/research` — shown in-app as "Community research: status quo vs proposed" win rates per challenge.

## Quick start (local)

```bash
npm install
npm start
```

Open http://localhost:8787 → **Multiplayer** tab → **Create room** → **Copy share link**.

Friends open the same URL (`/?room=CODE`) and join.

## Shareable deploy (Render)

1. Push this repo to GitHub.
2. In [Render](https://render.com): **New** → **Blueprint** → select this repo (`render.yaml`).
3. After deploy, share `https://YOUR-SERVICE.onrender.com/?room=CODE`.

Or one-off:

```bash
npm install
npm start
# then expose with a tunnel if you want a temporary public URL
```

## How multiplayer works

- Server owns LWMA windows, difficulty, next-block sampling, and chain history.
- Clients send intents only: join, set hashrate, start/stop (host).
- `/api/rooms` discovers listed rooms from the server's in-memory room registry; hosts can make a room private without disabling exact-code or invite-link joins.
- Mining race: `rate_i = hashrate_i / targetDiff_i`, winner ~ categorical, block time ~ exponential — the LWMA feedback loop is live, so difficulty responds to power shifts.
- TIP-004 consecutive same-algo penalty doubles target time per streak (set by the challenge variant, not the host, to keep experiments clean).
- `speedup` compresses simulated seconds into wall-clock time so rooms feel interactive.

Rooms and WebSocket sessions are process-local and disappear on restart. Run one Railway replica: multiple replicas would each have a separate room list and WebSocket registry until shared room state and sticky routing are added.

## Challenges & research data

- Challenge scripts live in `server/challenges.js` (bots, schedules, objectives). Add a new level by adding a factory there.
- Round results append to `data/rounds.jsonl`; aggregates are served from `/api/research`.
- Windows are re-seeded to difficulty equilibrium for the opening power mix each round, so scores measure attack response rather than warm-up drift.

## For AI agents

Contributing with a coding agent (Cursor, Claude Code, Codex, …)? Point it at **[AGENTS.md](AGENTS.md)** — project map, how to run and verify, simulation invariants, and PR expectations. Step-by-step recipes for the most valuable contributions (new challenges, network variants, battlefield visuals, Copilot tuning) live in **[skills/](skills/)**. Humans: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Solo research UI

All original tabs still work (baseline, block-time comparison, validation, etc.). Open `index.html` via the Node server (needed for multiplayer WebSocket); solo charts are unchanged.

## Credit

Original LWMA simulation and validation approach by [m4r1m0/tari-diff-sim](https://github.com/m4r1m0/tari-diff-sim).
