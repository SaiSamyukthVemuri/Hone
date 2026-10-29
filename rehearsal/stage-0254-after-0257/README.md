# REHEARSAL - NEVER MERGE. PREPARATION ONLY / HELD.

STAGE-0254-AFTER-0257: the 0254 online scripts rebuilt for the case where 0257 is already hosted, so 0254 is a below-head apply that needs
`db push --include-all`. Nothing here is approved; 0254 stays held unless Sam separately approves its exact changes.

- `check.sh`: runs the shipped script text against a stub CLI (159 assertions, N-of-N), macOS bash 3.2 and Linux.
- `scripts/ci/stage-0254a-push-rehearsal.sh`: the real pinned CLI v2.102.0 against a disposable PostgreSQL (hosted prefix + the real sealed 0257).
  The pending 0254 there is a synthetic stand-in carrying the real file name (the sealed 0254 needs payment tables the stand-in schema lacks).
- `reference/`: the reviewed 0254 originals, sealed SQL, read queries and the 248-file list the package is derived from.
