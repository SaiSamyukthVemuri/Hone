# FINDING — every new `public` table is created writable by `anon` and `authenticated`

**Status:** open · **Owner:** unassigned · **Scope:** repository-wide · **Not part of WAIT-ADMIT-01**

Recorded while authoring migration 0193. 0193 makes **its own three objects** safe and
deliberately does nothing about the general case; that is this ticket.

## The finding

`pg_default_acl` carries, for tables in `public`, from **both** the `postgres` and
`supabase_admin` grantors:

```
anon=arwdDxtm | authenticated=arwdDxtm | service_role=arwdDxtm
```

`arwdDxtm` is INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN.
Every new table in `public` is therefore created with **full DML already granted to the
browser roles**, before any migration statement runs.

That is why `public.studios` grants UPDATE to `anon` and `authenticated` across all 47 of
its columns while `grep -rn "grant .* on .* studios" supabase/migrations/` returns
nothing. Nothing granted it. The default did.

## Why it is not repairable after the fact

A table-level grant **cannot be narrowed per column**: `REVOKE UPDATE (col)` succeeds and
changes nothing. RLS is not a substitute — a policy authorises a **row**, never a column.
So once a table has taken the default table-level grant, the only way to protect one
column is to revoke table UPDATE and re-grant every other column by name.

## Severity: latent, not live

Tables that strip their defaults are safe. Tables that rely on RLS alone are one policy
mistake from exposure, with no grant-layer backstop. Known-good examples:

- `0185_new_client_waitlist_entries.sql` — `revoke all ... from public, anon,
  authenticated, service_role;` then `grant select ... to authenticated;`
- `0188_new_client_waitlist_invitations.sql` — same, plus a **positive column list** that
  excludes `token_hash`
- `wait03b-b1-scoped-offer-allowance.PROTOTYPE.sql` — moved an allowance column off
  `studios` for exactly this reason
- `0193_waitlist_admission_authority.sql` — this file's three new tables

## The gap

`tests/security/clinical-rpc-grant-guard.test.ts` guards the **function** half of this
defect class (`ALTER DEFAULT PRIVILEGES` also arms `EXECUTE` for all three roles — missed
for `anon` in 0129 and for `service_role` in 0164).

**There is no equivalent guard for tables.** A future migration that creates a table and
forgets the revoke is green in CI by default.

## Proposed remediation (its own ticket, not this lane)

1. An inventory-plus-allowlist guard in the shape of
   `tests/security/service-role-allowlist.ts`: for every table in `public`, assert `anon`
   and `authenticated` hold no INSERT/UPDATE/DELETE unless the table is explicitly listed
   with a justification. Additive, cheap, and it would have caught the disproved
   admission-policy-on-`studios` design at review.
2. A one-time audit of existing `public` tables against that guard, repairing only those
   where a repair is possible without a large re-grant.
3. `studios` specifically needs its own decision: repairing it means revoking table UPDATE
   and re-granting 46 columns, which is a real blast radius and should not be undertaken
   as a side effect of a feature.

Do **not** fold any of this into a feature PR.
