# Network research candidate process

Submitting a candidate starts a review; it does **not** automatically add the candidate to the official randomized research pool. Approval or randomized-pool inclusion means the candidate is eligible for comparative simulation research and deeper validation. It is not a finding that the change is safe for mainnet, full-node consensus validation, protocol certification, or mainnet approval.

## Lifecycle

1. **Draft proposal** — open the [network candidate issue form](https://github.com/marguerite347/tari-diff-sim-multiplayer/issues/new?template=network-candidate.yml) and add a registry entry with status `draft`.
2. **Reproducibility and invariant review** — maintainers verify exact parameters, deterministic seeds, the live LWMA feedback loop, the 120-second target, equilibrium seeding, schema compatibility, and security boundaries.
3. **Exploratory/manual testing** — targeted rounds use manual variant selection. These rows are tagged `assignmentMode: manual` and never mixed into official randomized evidence.
4. **Minimum evidence threshold** — before approval, provide reproducible baseline and candidate runs across every relevant challenge. The proposal must define its sample threshold; the default expectation is at least 30 completed rounds per challenge×variant cell from multiple seeds, with more required when results are noisy.
5. **Maintainer approval** — maintainers review implementation, evidence, tradeoffs, and whether adding another randomized arm would dilute existing research.
6. **Randomized-pool eligibility** — only an approved candidate with sufficient evidence may be separately promoted to `randomized`. Promotion requires maintainer approval and a reviewed code change; registry status alone never changes runtime behavior.
7. **Decision and archive** — candidates become accepted/approved, rejected, or retired. An accepted/approved result identifies a candidate for deeper testing; it does not approve a mainnet change. IDs are immutable and never reused. Keep proposal links, review decisions, reproduction details, and summarized evidence in the registry/history even after retirement.

## Proposal requirements

A proposal must include:

- Candidate name, immutable lowercase ID, author, and GitHub contact.
- A falsifiable hypothesis and the network problem being addressed.
- Exact parameter changes from status quo, including LWMA window, penalty behavior, and any future parameters.
- Threat model and challenges expected to improve.
- Expected benefits and explicit tradeoffs or failure modes.
- Metrics and falsifiable acceptance criteria covering objective success, stability, mean block time, orphan rate/count, deepest reorg, longest block wait, and difficulty swing.
- Reproduction instructions, software/commit version, deterministic seeds or data range, sample counts, and a status-quo baseline comparison.
- Research-integrity and security considerations, including bias, assignment mode, key/data handling, and schema compatibility.

Raw community output in `data/` must not be committed. Provide a compact evidence summary and link to an external archive when raw artifacts are needed.

## Statuses and evidence

Registry statuses are `draft`, `exploratory`, `approved`, `randomized`, and `retired`. Rejection is recorded as `retired` with a decision explaining why, so the immutable ID remains reserved. `builtin` may be used as an origin marker, but the registry `status` must use one of the schema statuses.

Use `npm run validate:candidates` before opening a candidate PR. Candidate implementation PRs should use `.github/PULL_REQUEST_TEMPLATE/network-candidate.md`.
