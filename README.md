# Tari Diff Sim — Multiplayer

Fork of [m4r1m0/tari-diff-sim](https://github.com/m4r1m0/tari-diff-sim) with **shareable multiplayer rooms**.

Players join a room, allocate hashrate across Tari's four PoW algorithms, and watch a shared LWMA + TIP-004 mining race on a server-authoritative chain.

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
- Mining race: `rate_i = hashrate_i / targetDiff_i`, winner ~ categorical, block time ~ exponential.
- TIP-004 consecutive same-algo penalty doubles target time per streak (host can toggle).
- `speedup` compresses simulated seconds into wall-clock time so rooms feel interactive.

## Solo research UI

All original tabs still work (baseline, block-time comparison, validation, etc.). Open `index.html` via the Node server (needed for multiplayer WebSocket); solo charts are unchanged.

## Credit

Original LWMA simulation and validation approach by [m4r1m0/tari-diff-sim](https://github.com/m4r1m0/tari-diff-sim).
