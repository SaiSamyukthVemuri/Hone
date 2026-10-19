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

## Outstanding schema proof

Finding #860 / 4309278439 is confirmed in frozen 0223: unconstrained PostgreSQL
`numeric` accepts `Infinity` and `-Infinity`; its finiteness guard rejects only
`NaN`. The additive repair is proposed in
`production/proposals/machine-finite-readings.sql`, outside executable migrations.
No new number is allocated to Machines in the coordinator checkpoint. Do not edit
0223, invent a number, or reuse held 0234. The proposed `NOT VALID` constraint
enforces new inserts through all recording paths without modifying old immutable
records. Existing non-finite rows, if any, require separate operator-led review;
the proposal makes no claim that historical rows are valid.

After allocation, promote the repair into its own migration; prove it on the owned
stack in a granted slot. `machine-finite-readings.db.test.ts` deliberately fails
for infinity on 0223 alone and never applies the repair itself. Run it before and
after the repair as a negative control, then run the publication and affected
machine DB tests. No DB/browser proof has yet been run for this change.

## Required P0 model evidence

Both Apilus Senior 3G and Junior 3G remain required P0 work and distinct contracts.
The current dry-run publishes neither. Senior retains only its already-modelled
MultiPlex structure; field evidence and conflicting frequency remain unresolved.
Junior remains identity-only with no modelled modes. Do not borrow xCell/Senior
fields or guess units, precision, modes or activation.

The authoritative evidence requests remain each profile's `openQuestions` and
`resolvedBy` in `lib/machines/catalogue.ts`. Obtain the matching physical unit's
manual revision/settings-screen evidence and review the exact model separately.
Publication infrastructure alone does not complete HON-8 or either P0 model.

Holds remain: #926 evidence-only, #920/0234 held, no production merge/deploy/write
or hosted migration, no live provider actions or customer-data changes, demo off.
