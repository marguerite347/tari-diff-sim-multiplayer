# Validation roadmap

This roadmap separates evidence the repository can produce today from stronger validation that would require real Tari node software, a controlled network, and protocol governance. Progress through a tier increases confidence; no tier by itself automatically approves a mainnet change.

## Tier 1 — Historical replay (available today)

The solo simulator replays a fixed snapshot of Tari mainnet block data and compares LWMA window behavior across deterministic or rerandomized runs. This is useful for checking calculations against known history and exploring parameter sensitivity.

Limits: historical replay cannot create new adversarial conditions, model community responses, or execute the full node and peer-to-peer stack.

## Tier 2 — Multiplayer Monte Carlo game (available today)

Block Race runs a centralized, server-authoritative model of multi-algorithm mining and difficulty adjustment. Seeded stochastic block discovery, scripted attacks, randomized network variants, and human or Copilot hashrate decisions produce many comparative scenarios.

This tier can support statements such as "candidate A produced fewer modeled dominance failures or shorter stalls than the status quo under the same attacks." It is useful for generating hypotheses, finding tradeoffs, engaging the community in controlled stress tests, and selecting cases for deeper validation.

Limits: the game does not run real Tari nodes, execute the full consensus and networking implementation, or certify mainnet safety.

## Tier 3 — Isolated multi-node Tari test network (future)

Run multiple real Tari node processes in an isolated test network. Inject controlled hashrate shifts, latency, packet loss, partitions, restarts, and adversarial mining schedules. Replay scenarios derived from Tiers 1 and 2, then compare full-node outcomes with the game model to identify modeling gaps.

Expected evidence includes consensus behavior, propagation and partition effects, reorg handling, implementation-level performance, logs, and reproducible scenario definitions. This harness does not exist in this repository today.

## Tier 4 — Formal implementation review and testnet rollout (future)

Translate a candidate into production-quality protocol code, complete focused security and consensus review, add conformance and regression tests, document activation and rollback behavior, and conduct a monitored rollout on an appropriate public or governance-approved testnet.

Any mainnet decision belongs to Tari's protocol review and governance process. Game acceptance, favorable Monte Carlo results, or successful isolated tests are inputs to that decision—not substitutes for it.
