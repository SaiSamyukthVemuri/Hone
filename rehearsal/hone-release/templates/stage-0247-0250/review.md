# Verify bundle for migrations 0247-0250: derived expectations to REVIEW

verify_sha (sha256 of verify.tar): `0d299a1699cdc94ee78e21cb8c670b0971fc8b93cf1836472b342dff57b116f2` (reproducible: the same files give the same sha)

Source files (sha256):

- `0247_appointment_email_operation_authority.sql` 9f76565afc5309b9047675564f40c19f776d2588a40c56266483228ba444dfe4
- `0248_intake_protected_write_enforcement.sql` 1f6f9ad0026cee66b970e9dc630f1497aa10966df2adb9433d8f8c85bbc44cc3
- `0249_session_payment_claim_admission_fence.sql` 36941328b7226fb345ca74194a2e378678a8231ca88d19a1697282313d58ef1a
- `0250_appointment_email_stale_preparation_retire.sql` 09e54285e39a45ab1c6f2ae2f12554bdfa4a78454a821a3d83b0cf1a658ac09e

## Checks in the bundle

| id | what | expectation |
|---|---|---|
| functions-exist | every function the stage creates exists | 1 row(s): `[{"n": 13}]` |
| tables-exist | every table the stage creates exists | 1 row(s): `[{"n": 3}]` |
| rls-enabled | row level security is enabled on every table the stage enables it on | 1 row(s): `[{"n": 3}]` |
| function-acl | final EXECUTE privilege per (function, role): the last GRANT/REVOKE in the stage wins | 36 row(s): `[{"fn": "public.authorize_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,jsonb)", "ok": false, "r": "anon"}, {"fn": "public.authorize_appointment_email_operation(uuid,uuid,jsonb,text,uuid,text,text,jsonb)", "ok": false, "r": "authenticated"}, {"fn": "public.authorize_appointment_ema` |

## Needs a reference database (NOT in the bundle unless --capture supplied them)

- `function-bodies`: md5 of each function's source (needs a reference database)

## NOT covered (statement kinds the tool did not derive a check from; count)

- `alter table public.appointments`: 1
- `alter table public.clients`: 1
- `alter table public.practitioners`: 1
- `alter table public.services`: 1
- `alter table public.studios`: 1
- `begin`: 4
- `commit`: 4
- `create schema appointment_email_private`: 1
- `create sequence appointment_email_private.authority_revision_seq`: 1
- `create trigger appointment_email_intake_epoch`: 1
- `create trigger appointment_email_revision`: 5
- `create unique index`: 1
- `do $$ declare`: 1
- `do $preflight$ declare`: 1
- `do $verify$ declare`: 1
- `revoke all on`: 3
- `revoke execute on`: 1
- `set local lock_timeout`: 4

OPS: confirm each expectation against the intent of the stage, and decide whether the not-covered kinds need a hand-written check before approving `verify_sha`.
