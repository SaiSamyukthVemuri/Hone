# Fingerprinted database baseline

A verified, fingerprinted copy of the migrated, seeded **local** database that independent app, DB and e2e
tests restore instead of rebuilding the whole migration chain.

**Not for chain qualification.** Migration-chain, upgrade and rollback proofs keep using a fresh
`npx --yes supabase@2.102.0 db reset --local`. A baseline only stands in for the chain; it never proves it.

```bash
node scripts/db-baseline/cli.mjs key                                    # the key for this checkout
node scripts/db-baseline/cli.mjs build   --container supabase_db_<A>    # A: stack with the chain applied from scratch
node scripts/db-baseline/cli.mjs seal    --container supabase_db_<B>    # B: a different, EMPTY stack (no migrations)
node scripts/db-baseline/cli.mjs restore --container supabase_db_<B>    # any empty or used local stack
```

## The cache key (automatic invalidation)

`<cache>/<key>/` where `key` is the sha256 of every `supabase/migrations` file (name and content), the synthetic
seed (`seed.sql`), the allowed seeded-table list and the SQL the scripts run (`sql.mjs`). Change any byte of any of them and the key changes, so
the old entry is not found and `restore` exits 3 asking for a fresh build. Entries are immutable and read-only; there
is no refresh in place and no fallback to another entry. The cache directory is `HONE_DB_BASELINE_CACHE`, an owner-set directory outside the repo (or `--cache`); there is no
default, and the directory is created `0700`.

## `seal` and `restore` are DESTRUCTIVE

Both drop the `public` and `supabase_migrations` schemas of the stack they point at. They therefore refuse unless the stack is
the caller's own: the paired `E2E_SUPABASE_URL` + `HONE_LOCAL_DB_URL` of that stack (loopback, one stack, and the database port
is this container's published port), or an explicit `--confirm-owned <project>` naming it. They also refuse whenever
`DOCKER_HOST` is set or the docker context is not the local default. Never point them at a shared test stack.

## Only synthetic data is cached

`build` refuses unless `auth.users` is empty and every row in `public` is in an allowed migration-seeded reference table
(`allowed-seeded-tables.json`, part of the cache key); otherwise it prints the unexpected table names.

## What is in an entry

`baseline.dump` (`pg_dump -Fc -n public -n supabase_migrations`), `chain-fingerprint.txt`, and what a schema dump does
**not** carry, regenerated from the chain stack and replayed:

- `extensions.sql`: extensions the migrations create (`btree_gist`); without it the exclusion constraints cannot be rebuilt.
- `acl.sql`: explicit grants from `aclexplode`. `pg_dump` emits no GRANT for an ACL equal to the built-in default, so a
  plain restore lets the target's default privileges (`anon`, `authenticated`, `service_role`) apply on top and can give a
  restored table **more** access than the chain gave it. `restore` therefore uses `--no-acl` and replays this script
  (revoke from everyone, then grant exactly the chain's).
- `triggers.sql`: triggers the migrations put on tables outside the dumped schemas (`auth.users`).
- `restored-fingerprint.txt` and `verified.json`, written by `seal` after a verification restore into an empty stack.

## Verification is mandatory

`restore` runs with `--exit-on-error` in one transaction, then fingerprints the database (migration list, catalog,
grants, extensions, objects outside `public`, table row counts, `auth.users`) and compares against **both** the chain
fingerprint and the sealed verification restore. Grants must be identical to the chain's; any grant the restored side
has that the chain does not is reported as `EXTRA GRANT`. The catalog is compared ignoring parenthesisation only,
because a dump and restore re-deparses some CHECK constraints (`a AND (b AND c)` becomes `a AND b AND c`), so the
chain's catalog md5 cannot equal the restored one. On any mismatch the database is cleared and the command exits 1.

## Seed

Hone has no `supabase/seed.sql`; every DB test seeds its own studio through `tests/db/helpers/harness`. `seed.sql` is an
intentionally empty, hashed placeholder: a shared row would change counts tests assume.

## Not covered

Types' own ACLs, policies outside `public` (they are fingerprinted, not replayed: a mismatch refuses the restore), Storage
(the CI stack does not start it) and Auth data.
