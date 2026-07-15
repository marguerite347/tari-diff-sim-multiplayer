## Community challenge

Process: [docs/challenge-proposal-process.md](../../docs/challenge-proposal-process.md)

Challenge ID:
Proposal issue:

## Seeded balance summary

Report commit, seed range, sample counts, and ignored/human/Copilot outcomes for both `lwma90` and `lwma45_tip004`. Link raw evidence externally; do not commit `data/`.

## Checklist

- [ ] The immutable challenge ID is new, lowercase, and will never be reused.
- [ ] Factory, bot schedules/shadow parameters, `durationBlocks`, and `scoredFromBlock` are documented.
- [ ] Existing `ObjectiveTracker` type/threshold matches the threat and alone determines the network verdict.
- [ ] `FORCE_CHALLENGE=<id>` exercises the implementation.
- [ ] Many seeded runs cover both builtin variants, ignored play, meaningful human response, and Copilot response.
- [ ] The challenge is losable when ignored, winnable through meaningful response, and has no guaranteed outcome.
- [ ] Any timing/window hypothesis or potential configuration favoritism is declared and tested.
- [ ] Battlefield events, ticker narration, and Copilot hooks make the threat legible.
- [ ] LWMA feedback, 120s target, equilibrium seeding, reproducible PRNG, and research schema remain intact.
- [ ] Performance, cleanup, edge cases, and security considerations were checked.
- [ ] No raw `data/`, skybox library, secrets, tokens, or user data are committed.
