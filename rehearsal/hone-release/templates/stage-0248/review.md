# Verify bundle for migrations 0248-0248: derived expectations to REVIEW

verify_sha (sha256 of verify.tar): `9456150fe728b0a406c247e489af3765f8e84719d1455ab028f63ea3110e96f4` (reproducible: the same files give the same sha)

Source files (sha256):

- `0248_intake_protected_write_enforcement.sql` 1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3

## Checks in the bundle

| id | what | expectation |
|---|---|---|
| functions-exist | every function the stage creates exists | 1 row(s): `[{"n": 1}]` |

## Needs a reference database (NOT in the bundle unless --capture supplied them)

- `function-bodies`: md5 of each function's source (needs a reference database)

## NOT covered (statement kinds the tool did not derive a check from; count)

- `begin`: 1
- `commit`: 1
- `do $$ declare`: 1
- `set local lock_timeout`: 1

OPS: confirm each expectation against the intent of the stage, and decide whether the not-covered kinds need a hand-written check before approving `verify_sha`.
