---
name: add-battlefield-visual
description: Add or change a visual effect on the Three.js battlefield (js/battlefield.js) — armies, walls, invaders, tower, orphan/reorg effects — wired to game events from multiplayer.js. Use when asked for battlefield visuals, 3D effects, or event-driven scene changes.
---

# Add a battlefield visual

The battlefield (`js/battlefield.js`) is a Three.js r149 scene: four algo armies around a central block tower, one lane per PoW algorithm. It's an IIFE returning a public API consumed by `js/multiplayer.js`; there is no build step — refresh the browser to see changes.

**Read `js/battlefield.js` first** — features are frequently in flight and details here may have drifted.

## How the module is structured

- **Scene setup** (`init`): renderer, lights, fog, then `buildTerrain`, `buildMonumentBase`, and per-algo `buildArmy` / `buildWall` / `buildInvaders`. Skyboxes load from `assets/skyboxes/manifest.json` (may be absent — always degrade gracefully).
- **State arrays** at the top, one slot per algo (0–3): `armies`, `invaders`, `walls`, `banners`, `siegeLights`, `klaxons`, plus effect queues `flyingBlocks`, `failFx`, `orphanFx`, `toppleFx`, `shadowGhosts`.
- **Render loop** (`animate`): camera orbit/auto-framing, then per-frame animators — `animateWalls`, `animateInvaders`, `animateFailFx`, `animateWeather` (cadence "weather": heat/gloom lighting), `animateForkFx`. Effects are objects pushed onto a queue with a `t`/`phase` field, advanced by `dt`, and removed + `scene.remove(mesh)` when done.
- **Lane constants**: `LANE_COLORS = [0xff4d5e, 0x37b6ff, 0x3dffa2, 0xffb640]`, `ALGO_LABELS = ['RandomXM', 'Sha3x', 'RandomXT', 'Cuckaroo']`, positions in `ARMY_POS` (N/E/S/W). Keep per-algo arrays in this order.

## The public API (event hooks from multiplayer.js)

| Hook | Called from `multiplayer.js` when | Drives |
|---|---|---|
| `setForces(perLane)` | every block, with `{hostile, mine, other}` per lane from `forceBreakdown()` | army/invader headcounts, your cyan squad tint, `updateThreat` (invader march distance) |
| `setTelemetry(entries)` | every block, with the server's per-algo `telemetry` | banners (`drawBanner`), difficulty wall heights (log-scaled vs `diffBaselines`), penalty frost |
| `blockMined(block)` | `block_mined` message | `launchBlock` arc over the wall, streak heat, `failedAttempt` staging after spikes |
| `setCadence({meanBt, target, speedup})` | every block | weather: heat (hot chain) vs gloom/fog (stalled chain) |
| `orphanBlock(orphan)` / `setShadowCount(count, algo)` / `reorgEvent(depth, algo)` | orphan on a block / `shadow_block` / `reorg` messages | rejected-block crumble, ghost stack, tower topple + camera shake |
| `reset()` / `nextSkybox()` | round transitions (`challenge_brief`) | clears all effect queues and baselines |

To visualize a **new** event: add a method here, expose it in the return object at the bottom, and call it from the matching `case` in `handleServerMessage` in `js/multiplayer.js` — always guarded (`if (window.Battlefield) Battlefield.myEffect(...)`). If the event also deserves text, add an UPPERCASE `ticker(...)` line there too (that vocabulary — walls, troops, ticker narration — is the game's explanatory layer; visuals should reinforce it).

## Conventions

- Reuse the low-poly look: `MeshLambertMaterial` with `flatShading`, merged box geometry (`soldierGeometry`), `InstancedMesh` for crowds.
- Performance: this runs alongside charts and the HUD. Prefer instancing, cap effect queue sizes, and always `scene.remove` + let materials/geometry go when an effect ends (clone materials before mutating shared ones — see `reorgEvent`).
- Anything driven per-block should ease toward targets in the animate loop (see `wall.currentH → targetH`, `invader.threat → threatTarget`) so changes read as motion, not teleports.
- Add cleanup for your effect to `reset()` — rounds recycle the scene.

## Verify visually

1. `npm start`, open http://localhost:8787, create a room, Start.
2. Pick the challenge that triggers your event: `FORCE_CHALLENGE=shadow` for ghosts/reorgs, `flood` for invaders/walls; `ORPHAN_WINDOW=60 npm start` makes orphans frequent.
3. Watch several occurrences: correct lane/color, no lingering meshes after `reset()` (start a second round), stable frame rate with the tower tall.
4. Drag/zoom the camera and resize the window — effects must survive `onResize` and auto-rotate.
