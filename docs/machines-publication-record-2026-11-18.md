# Machine contract publication record, 2026-11-18

Record only. This follows [the 2026-11-17 record](machines-publication-record-2026-11-17.md), which is left
as written. Nothing here registers a machine for any studio or authorizes any further publication.

## What happened

The owner published the ten planned contracts to production under a per-change approval, from the clean
production commit `2ac628f29f377a0da1fd9f2ef6f0e67c73f7ef7e` (declared hosted migration max 0357), with the
hosted runner (`scripts/publish-machine-contracts-hosted.mjs`) and the plan below.

- Plan sha256: `fccd6216257eeddaf6f796b1aa67a745cf5f45770ede8cdd2410559c0cea6d9a`.
- Approval token sha256: `8d37bc93a9c7715191d5d56526ff14f4dfdaa3d6e344513a3a34a990a150a0ed`.
- Runner receipt: `docs/production/hosted-publication-receipts/8d37bc93a9c7715191d5d56526ff14f4dfdaa3d6e344513a3a34a990a150a0ed.json`,
  committed byte for byte as the runner wrote it. It holds a fingerprint of the project reference, not the reference.
- Result: status `complete`; ten published; none unchanged, none not attempted, no read-back mismatch, none
  unreadable; no partial run; every planned row was absent before the run.
- The owner's own read afterwards showed seven Senior 3G and three Junior 3G contracts, all version 3.

The ten modes are Senior 3G flash, microflash, multiplex, blend, omniblend, multiblend and electrolysis, and
Junior 3G flash, blend and electrolysis. The holds in the earlier record are unchanged: Junior Thermolysis
precision, Junior OmniBlend order, the other models and all superseded versions stay unpublished.

## Not established by this record

- That Settings > Machines lists Senior 3G and Junior 3G for an owner: that served check is the owner's own look
  and is not recorded here.
- Registration of any machine for any studio, and physical acceptance of a studio's own unit against the
  manual edition and firmware: separate acts and gates.
- The project kind and migration head are asserted by the approval token (the approver's separate read-only
  check), not proven by the runner; the receipt says so itself.
