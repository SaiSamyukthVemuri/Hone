# Synthetic Fett twin — local-only runbook

A **persistent, reproducible synthetic Fett clinic** (#825) for demos and walkthroughs. It runs on ONE owned,
isolated local Supabase stack and a loopback-bound app. It is **not** production, **not** the production
`hone-synthetic-twin` tenant, and **not** a release vehicle. Real manufacturer machine profiles stay blocked.

## What it holds
Seed: `tests/twin/fett-twin.seed.twin.ts`, with deterministic owned ids in `tests/twin/fett-twin-manifest.ts`.
- **Clinic and staff:** LA studio `fett-twin` (America/Los_Angeles), US/USD, capacity LIVE. One owner, five
  electrologists, and a receptionist invited and accepted through the real command.
- **Clients and bookings:** 12 synthetic clients, upcoming bookings (including parallel practitioners and a
  refused same-practitioner clash), and one receptionist booking.
- **Machines:** synthetic machine units, a remembered selection, two coherent setting revisions, and a retired
  unit that stays named in history.
- **Payments:** a fake-Stripe US test account with a card on file, a $150 USD visit ready to charge,
  "Paid another way", and US e-Transfer refused.
- **Delivery:** email accepted and refused, SMS refused (two incidents), and an owner concern.
- **Canada:** a separate regression studio `fett-twin-ca` (CA/cad, e-Transfer accepted).

Synthetic identities only (`@fett-twin.synth.local`, 555-01xx). Every SMS toggle is off and no client holds
SMS consent. **Dates:** past visits carry synthetic visit dates. A setup capture's "Recorded" date is the
database time it was written, which is never backdated.

## Seed, prove, reset
```bash
scripts/fett-twin/reset.sh <supabase-workdir>                    # guarded reset of THAT stack, then seed
scripts/fett-twin/reset.sh <supabase-workdir> --seed-only        # seed if absent / prove if present
scripts/fett-twin/reset.sh <supabase-workdir> --cleanup-dry-run  # inventory what the twin owns
```
`<supabase-workdir>` holds the twin stack's own `supabase/config.toml`.

**The script refuses unless all of these hold:**
- the project id is not the shared `Hone-0162`;
- its ports are not the shared 5432x block;
- `supabase_db_<project>` is running on that db port;
- no browser lane of this worktree is running.

**Credentials** come from `supabase status -o env` for that workdir. Nothing secret lives in the repository.

**Idempotence is proven, not assumed.** An existing `fett-twin` is checked against the manifest's ids and 14
state facts. If it is owned and complete, the script writes nothing and prints the facts. If it is partial or
unrelated, it is **refused**, with every mismatch listed and the recovery instruction.

**Cleanup never deletes immutable history.** Settlements refuse deletion, readings are immutable, and those
guards are not bypassed. Remove a full twin with the guarded reset.

## Serve (loopback only)
```bash
scripts/fett-twin/app.sh export <commit> <app-dir>      # pinned copy; acceptance runs never rebuild it
scripts/fett-twin/app.sh build  <app-dir> <supabase-workdir>
scripts/fett-twin/app.sh serve  <app-dir> <supabase-workdir>   # next start -H 127.0.0.1 -p ${FETT_TWIN_APP_PORT:-3995}
```
**The server starts from an empty environment** (`env -i`). It gets the fake email transport, fake Stripe for
session charges and refunds, and the synthetic machine profile. Each of those refuses to run in a deployed
runtime.

**Every outbound connection to a non-loopback host is refused** by `scripts/fett-twin/egress-deny.cjs`. Each
refusal is logged to `egress-refused.jsonl` beside the app directory.

**Not covered by the fence:**
- the build itself fetches Google Fonts, the same as every CI build;
- the viewer's own browser may load Stripe.js with a dummy publishable key.

## Access
From the operator's machine, using its established SSH alias for this host:
```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -L 3995:127.0.0.1:3995 -L 63321:127.0.0.1:63321 -L 63324:127.0.0.1:63324 <host-alias>
```
Adjust the API and Mailpit ports to the twin stack's own ports. Then:
1. Open `http://localhost:3995/login` and tick "I am using my invited email address".
2. Enter a demo account.
3. Open Mailpit at `http://localhost:63324` and click the magic link.

| Role | Account (magic link only) |
|---|---|
| Owner | `owner@fett-twin.synth.local` |
| Electrologists | `electrologist-1`…`electrologist-5@fett-twin.synth.local` |
| Receptionist | `front-desk@fett-twin.synth.local` |
| Support operator | `twin-operator@fett-twin.synth.local` (admin via the app's allowlist) |
| CA regression owner | `ca-owner@fett-twin.synth.local` |
| Public booking | `http://localhost:3995/book/fett-twin` |

## Walkthrough
`node scripts/fett-twin/walkthrough.mjs` drives the whole path: owner, then receptionist UI booking, then
practitioner treatment history and the USD charge with receipt, then the owner refund, public booking, and
support delivery recovery. It also checks role and tenant negatives.

It **mutates** the twin, so run it once per fresh seed. A step passes only when its assertion ran against
rendered content.
