# Contributing

Thanks for helping! This is a community **research game**: every finished round becomes a datapoint comparing Tari network configurations (`data/rounds.jsonl`, aggregated at `/api/research`). **The integrity of that data matters more than any feature** — changes that alter the simulation's behavior or the round-result schema affect everyone's collected results, so tread carefully there and call it out in your PR.

Research results are comparative Monte Carlo simulation evidence, not proof that a candidate is safe for mainnet and not validation of full-node consensus behavior. Preserve that boundary in code, documentation, UI copy, issue discussions, and evidence summaries. Acceptance into a game research pool means a proposal is eligible for stronger follow-up testing; it is not protocol certification or mainnet approval. See [Research scope and limitations](README.md#research-scope-and-limitations).

## Where to start

- **[AGENTS.md](AGENTS.md)** — project overview, architecture map, how to run and verify, simulation invariants, and code style. Written for AI coding agents but just as useful for humans. If you use Cursor, Claude Code, Codex, etc., point your agent at it.
- **[skills/](skills/)** — step-by-step recipes for the most valuable contribution types:
  - [add-challenge](skills/add-challenge/SKILL.md) — a new scripted attack scenario
  - [add-network-variant](skills/add-network-variant/SKILL.md) — a new candidate network config to test
  - [add-battlefield-visual](skills/add-battlefield-visual/SKILL.md) — Three.js battlefield effects
  - [tune-copilot-strategy](skills/tune-copilot-strategy/SKILL.md) — autopilot behavior and narration
- **[Network candidate process](docs/research-candidate-process.md)** — proposal, exploratory evidence, review, registry, and eligibility for official randomized research
- **[Challenge proposal process](docs/challenge-proposal-process.md)** — community stress-test design, seeded two-variant balance evidence, review, and pool inclusion
- **[candidates/](candidates/README.md)** — machine-readable candidate registry; validate it with `npm run validate:candidates`

## Quick start

```bash
npm install
npm start   # http://localhost:8787
```

## PR checklist

- [ ] Small, focused diff — one feature or fix, no drive-by refactors
- [ ] Verified in the browser: played a round exercising the change (note `FORCE_CHALLENGE`/`ORPHAN_WINDOW` used, if any)
- [ ] Server changes: restarted the server and confirmed a full round completes and records
- [ ] No simulation invariants broken (see [AGENTS.md](AGENTS.md#simulation-invariants--never-break-these))
- [ ] Round-result schema, challenge ids, and variant ids unchanged — or the change is prominently flagged in the PR description
- [ ] Candidate changes follow the governance process; manual evidence is not mixed into randomized aggregates; `npm run validate:candidates` passes
- [ ] New challenges follow the challenge proposal process and include seeded ignored/human/Copilot evidence across both builtin variants
- [ ] Nothing from `data/` or `assets/skyboxes/` staged (`git status` before committing)
- [ ] Plain JS, no new frameworks/build steps; UPPERCASE arcade copy for player-facing HUD text
