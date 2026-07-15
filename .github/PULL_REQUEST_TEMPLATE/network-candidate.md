## Network candidate

Process: [docs/research-candidate-process.md](../../docs/research-candidate-process.md)

Candidate ID:
Proposal issue:
Registry status:

## Evidence summary

Summarize baseline/candidate sample counts, seeds or data range, challenge coverage, and the falsifiable acceptance criteria. Link external raw evidence; do not commit `data/`.

## Checklist

- [ ] The variant ID is lowercase, stable, unique, and will never be reused.
- [ ] Candidate registry entry and supporting docs are included and pass `npm run validate:candidates`.
- [ ] I read `AGENTS.md`, `.cursor/rules/simulation-invariants.mdc`, `.cursor/rules/research-data.mdc`, and `skills/add-network-variant/SKILL.md`.
- [ ] LWMA feedback, 120s target, equilibrium seeding, deterministic PRNG, and historical schema compatibility remain intact.
- [ ] Manual/exploratory evidence is tagged and is not mixed into the official randomized aggregate.
- [ ] Tests cover each relevant challenge, both baseline and candidate, deterministic seeds/data range, and failure modes.
- [ ] Browser screenshots and a compact data summary are attached or linked where useful.
- [ ] No raw `data/`, skybox library, secrets, tokens, or user data are committed.
- [ ] Promotion to the randomized pool has explicit maintainer approval and sufficient evidence, or this PR remains exploratory only.
