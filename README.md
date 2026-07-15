# Tari Diff Sim — Block Race

Fork of [m4r1m0/tari-diff-sim](https://github.com/m4r1m0/tari-diff-sim) turned into a **centralized, multiplayer Monte Carlo research game**. In shareable rooms, community members take part in controlled network stress tests; every finished round becomes a datapoint comparing candidate Tari network changes against the status quo.

Players join a room and allocate hashrate across Tari's four PoW algorithms on a 3D battlefield. Each round draws:

- a random **challenge** ("level") — a scripted bot attack such as a hash flood, algo-hopping, or burst-mining whiplash, plus a no-attacker control round; and
- a random **network variant** — status quo (LWMA-90, no penalty) or the proposed change (LWMA-45 + TIP-004 penalty).

Players defend the chain with their sliders. The round is scored on objective metrics (rolling block-time stability, algo dominance), recorded to `data/rounds.jsonl`, and aggregated at `/api/research` — shown in-app as "Community research: status quo vs proposed" win rates per challenge. The visual game makes network behavior, attacks, proposals, and tradeoffs easier to see and discuss, including for people who do not specialize in consensus or mining algorithms.

Try the public game at [tari-diff-sim-multiplayer-production.up.railway.app](https://tari-diff-sim-multiplayer-production.up.railway.app).

## Research scope and limitations

Block Race is a centralized simulation of Tari's multi-algorithm mining and difficulty dynamics. The server models competing hashrate across four PoW algorithms, an exact port of Tari's LWMA calculation, stochastic block discovery, scripted attacks, difficulty feedback, TIP-004 streak penalties, orphans, and selected reorg behavior. Seeded randomness and randomized network-variant assignment make repeated rounds useful for Monte Carlo comparisons, while human and Copilot decisions create varied, human-in-the-loop scenarios.

The game can provide useful comparative evidence, such as "LWMA-45 + TIP-004 produced fewer dominance failures or shorter stalls than LWMA-90 under the same attacks." It can help identify promising proposals, failure modes, tradeoffs, and hypotheses worth testing more deeply.

It cannot establish that a proposed change is safe for mainnet by itself. It does not run real Tari node processes, execute full consensus or networking code, reproduce a live peer-to-peer network, or certify a protocol implementation. Its attacks, latency assumptions, miner behavior, and objectives are deliberately controlled model inputs; results are simulation evidence, not a mainnet safety approval.

For stronger validation, the next tier would run multiple real Tari node processes in an isolated test network, inject controlled hashrate, latency, and partition conditions, and compare those results against the game model. The game is best used to generate hypotheses and large numbers of community-driven scenarios for that deeper test harness. See the [validation roadmap](docs/validation-roadmap.md) for the current and proposed validation tiers.

### Community participation

The project is also a public learning and participation tool, not only a dataset generator. Community play turns difficult network concepts into visible scenarios, builds shared awareness of attacks and design tradeoffs, and gives non-specialists a practical way to discuss proposals.

- [Open the public game](https://tari-diff-sim-multiplayer-production.up.railway.app), join a listed room, or share a room invite.
- [Propose a controlled stress-test challenge](https://github.com/marguerite347/tari-diff-sim-multiplayer/issues/new?template=challenge-proposal.yml).
- [Propose a network candidate](https://github.com/marguerite347/tari-diff-sim-multiplayer/issues/new?template=network-candidate.yml) for exploratory review and evidence gathering.
- Follow the [contribution guide](CONTRIBUTING.md) when implementing or reviewing a proposal.

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
- Clients send intents only: join, set hashrate, and authorized lifecycle controls.
- `/api/rooms` discovers listed rooms from the server's in-memory room registry. Listed rooms run an authoritative five-challenge session, then show a 20-second summary before returning everyone to the lobby; a lone human gets solo pause/resume/start-now/abandon controls, while two or more humans use server-managed lifecycle timing.
- Hosts can make a room private without disabling exact-code or invite-link joins. Private rooms remain host-controlled and unbounded, with the existing Continue/Return Setup flow after each challenge.
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
