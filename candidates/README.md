# Network candidate registry

One JSON file per immutable candidate ID records governance status and reproducible evidence metadata. Registry files do not automatically change `server/challenges.js` or enter a candidate into official randomized research.

Statuses:

- `draft` — proposal incomplete or awaiting initial review
- `exploratory` — eligible for manually selected testing only
- `approved` — reviewed and accepted as a candidate, but not necessarily randomized
- `randomized` — explicitly approved for the official randomized pool
- `retired` — rejected, superseded, or removed; its ID remains reserved

Follow [the candidate process](../docs/research-candidate-process.md), copy the schema fields into `<candidate-id>.json`, and run:

```bash
npm run validate:candidates
```

The current LWMA-45 + TIP-004 candidate is represented as a builtin, approved example. Runtime definitions remain server-authoritative.
