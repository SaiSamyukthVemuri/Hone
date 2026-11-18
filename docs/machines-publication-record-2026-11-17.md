# Machine contract publication record, 2026-11-17

Record only. Nothing here publishes, registers or authorizes anything: production has no machine
contract published by this record, and publication needs the owner's own per-change approval
(see [the publication mechanism](machines-contract-publication.md)).

## Dry-run at production tip `3abdf3f5e`

`node scripts/publish-machine-contracts.mjs --dry-run` (no credentials, no database, no network).
Plan sha256: `fccd6216257eeddaf6f796b1aa67a745cf5f45770ede8cdd2410559c0cea6d9a`.
The hash depends on the catalogue: any later catalogue change needs a fresh dry-run.

It would publish ten contracts, all version 3:

| Model | Modes |
|---|---|
| Dectro/Apilus Senior 3G | flash, microflash, multiplex, blend, omniblend, multiblend, electrolysis |
| Dectro/Apilus Junior 3G | flash, blend, electrolysis |

No xCell contract is in the plan.

## What stays held

- Junior Thermolysis: the time precision is unresolved (tenths on screen, hundredths in the text).
  Needs the Junior firmware version and a photo of the Thermolysis time screen.
- Junior OmniBlend: the starting-current order is contradicted between manual pages 20 and 31.
  Needs the Junior firmware version and the starting-current configuration screen.
- Superseded versions (Senior and Junior v1 and v2) are never newly published; their contracts stay
  so existing records keep their original meaning.
- Every other model (xCell, Platinum, Silhouet-Tone, GEMM-16 family) stays blocked on its own evidence.
- Disputed limits stay unenforced field notes: Senior OmniBlend maximum H.F. 19% against 29%, and Junior
  Electrolysis 0.99 against 1.99 mA. They do not block publication.
- Physical acceptance of a studio's own unit against the manual edition and firmware is a separate gate.

## Not established by this record

Whether production already holds any contract row (no hosted read was made), and whether the hosted
runner has had its exact-bytes review.
