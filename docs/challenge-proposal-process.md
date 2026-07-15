# Community challenge proposal process

Challenges are community-designed stress tests; network candidates are proposed rule/configuration changes. A challenge proposal does not upload runtime code or automatically join the official challenge pool. Acceptance means the scenario is eligible to produce comparative simulation evidence and inform deeper testing; it does not validate full-node consensus behavior, certify a network candidate, or approve a mainnet change.

## Lifecycle

1. **Proposal** — open the [challenge proposal issue form](https://github.com/marguerite347/tari-diff-sim-multiplayer/issues/new?template=challenge-proposal.yml) with a stable ID, story, attack mechanics, objective, and expected evidence.
2. **Design and reproducibility review** — maintainers check simulation invariants, seeded randomness, objective fit, research-schema compatibility, attack legibility, and abuse/performance risks.
3. **Local exploratory test** — implement on a branch and exercise it with `FORCE_CHALLENGE=<id>`. No proposal content is loaded dynamically by the public app.
4. **Balance validation across both builtin variants** — run many seeded rounds with `lwma90` and `lwma45_tip004`. Report ignored, purposeful human, and Copilot response outcomes.
5. **Maintainer approval** — maintainers review evidence, gameplay value, confounding assumptions, and maintenance cost.
6. **Challenge-pool inclusion** — a reviewed code change adds the factory to `CHALLENGE_FACTORIES`; inclusion is never triggered by an issue or registry file and is not a mainnet safety approval.
7. **Retirement/versioning** — challenge IDs are immutable and never reused. Materially different mechanics require a new ID. Retired evidence and decisions remain archived so old research rows retain meaning.

## Required design details

- Immutable lowercase challenge ID, player-facing name, author, and GitHub handle.
- Plain-language story and threat model.
- Bot names/roles and exact hashrate schedules, or complete shadow-miner parameters.
- `durationBlocks`, `scoredFromBlock`, objective type/threshold, and why that objective measures the threat.
- Expected battlefield visual events and ticker narration so the attack is legible as tower defense.
- Metrics expected to move: objective success, stability, mean block time, orphan count, deepest reorg, longest block wait, and difficulty swing.
- Edge cases, browser/server performance impact, input/security considerations, and cleanup behavior.

## Falsifiable balance evidence

Evidence must cover many deterministic seeds and **both** builtin network variants. State the seed range, commit, configuration, sample counts, and observed distributions—not only favorable runs.

A valid challenge must:

- Be losable when ignored.
- Be winnable through a meaningful player or Copilot response.
- Avoid guaranteed outcomes.
- Avoid structurally favoring one network candidate merely because attack timing was tuned to a particular window. If testing that interaction is the hypothesis, declare it and define acceptance criteria.
- Preserve the live LWMA feedback loop, equilibrium seeding, reproducible PRNG, and network-verdict/objective separation.

Use the challenge PR checklist in `.github/PULL_REQUEST_TEMPLATE/challenge-proposal.md`. Do not commit raw `data/`; attach a compact summary and link external evidence when needed.
