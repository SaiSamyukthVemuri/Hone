# Machine contract publication

Publication is an operator step after the reviewed catalogue and schema are
available. It is separate from profile activation and from practitioner charting.
This is T3 work: it writes a global clinical validation contract as `service_role`.

## Review the plan

Run `node scripts/publish-machine-contracts.mjs --dry-run`. It needs no credentials,
database, browser or server. It compiles the pure catalogue modules with the
already-declared TypeScript compiler into an automatically removed temporary
directory; no TS runner, dependency or second catalogue is introduced.

The JSON lists exact RPC arguments, all skipped modes with reasons, and a SHA-256
of the plan. Only current, active profiles and active modes with fully verified
fields qualify. Optional fields must be verified too: a mode is never published
partially. Open-question holds, unknown evidence references, unsupported precision
and required channel associations prevent publication. 0223 cannot store/enforce
required association; that needs a separate reviewed database change first.

Every publication calls `sync_machine_profile_contract`. Identical content returns
zero inserted fields; changed content at the same version is refused by the
database. The tool stops on the first refusal or uncertain response, without
automatic retries. Modes are separate transactions: after a failure, earlier
modes can already be published. Inspect the target and regenerate the plan before
a deliberate retry; unchanged contracts are idempotent.

## Local proof only

The only write entry is:

```sh
node scripts/publish-machine-contracts.mjs --apply-local --expect-plan=<reviewed-sha256>
```

It requires ops01's heavy-test slot recorded as `machines`, the lane's existing
`hone-mpx-0223` containers mapped to API 64821 and DB 64822, an undeployed process,
and the lane-local service-role key supplied as
`HONE_MACHINE_PUBLICATION_SERVICE_ROLE_KEY`. It reads no environment files, accepts
no target override, follows no redirects, and never starts containers or servers.
Run the usual shared-stack census before/after, and send START/END through the
existing coordinator process. Never change the slot holder yourself.

The production path is **disabled**. Sam must decide the sanctioned privileged
publication mechanism/credential handling and authorize each reviewed publication
against an exact catalogue and hosted schema. There is no hosted flag or automatic
deployment hook. A local result supplies no production authorization.

## Allocated finite-reading repair and local proof

Finding #860 / 4309278439 is confirmed in frozen 0223: unconstrained PostgreSQL
`numeric` accepts `Infinity` and `-Infinity`; its finiteness guard rejects only
`NaN`. OPS allocated 0235 for this repair only; after a fresh all-ref/worktree/open-PR
census, the proposal's unchanged SQL body was promoted to
`supabase/migrations/0235_machine_finite_readings.sql`. Frozen 0223 and held 0234
are unchanged. The additive `NOT VALID` constraint
enforces new inserts through all recording paths without modifying old immutable
records. Existing non-finite rows, if any, require separate operator-led review;
the migration makes no claim that historical rows are valid.

In the granted Machines slot, `machine-finite-readings.db.test.ts` produced the
expected two pre-repair failures (positive and negative infinity accepted) while
NaN was refused. After applying 0235 only to the owned 64821/64822 stack, its three
cases passed, including finite controls and zero reading/capture delta on refusal.
The existing publication case passed: verified publication becomes recordable,
unchanged replay is a no-op, changed content is refused and an unpublished pending
mode stays fail-closed. Its initial fixture error is preserved in the proof report.

These are rollback-scoped database-command tests, not a publication CLI transport
test or hosted publication. The six native DB cases also passed (Senior 4, Junior 2).
Full-chain reset, missing train composition, committed cross-connection reload and
native browser/mobile proof remain UNRUN. See
[the scoped proof](reviews/hon8-0235-db-proof-2026-10-19.md). The owned stack was stopped,
volumes preserved and the slot released; the shared frozen-stack census had zero delta.

## Required P0 model evidence

Both Apilus Senior 3G and Junior 3G remain required P0 work and distinct contracts.
The current dry-run publishes neither because activation remains explicitly held.
Both have independent manufacturer-documented v2 native numeric contracts; their
v1 contracts remain retained. See [the native contract record](apilus-3g-native-contracts.md)
for the implemented fields and narrow remaining precision/order/categorical gaps.
Do not borrow xCell/Senior fields or guess units, precision, modes or activation.

The authoritative evidence requests remain each profile's `openQuestions` and
`resolvedBy` in `lib/machines/catalogue.ts`. Obtain the matching physical unit's
manual revision/settings-screen evidence and review the exact model separately.
Publication infrastructure alone does not complete HON-8 or either P0 model.

Holds remain: #926 evidence-only, #920/0234 held, no production merge/deploy/write
or hosted migration, no live provider actions or customer-data changes, demo off.
