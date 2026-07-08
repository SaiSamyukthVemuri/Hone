# Hone — Release Changelog

Human-readable shipped-change history for the current wave. All entries below are **merged
to the production branch (`claude/build-hone-saas-hOex7`) and deployed** unless noted.
Reverse-chronological within the wave is not enforced; the table is ordered by PR number.
For schema detail see [migration-ledger.md](./migration-ledger.md); for the live / OFF / held payment
posture see [current-state.md](./current-state.md).

> Merge SHAs are recorded where captured at merge time. Earlier entries in this wave were
> merged to the production branch but their exact merge SHAs are not recorded here — verify
> via `git log origin/claude/build-hone-saas-hOex7` if an exact SHA is needed. Do not treat a
> missing SHA as "not shipped."

| PR | Migration | Live status | Impact | Safety notes |
|---|---|---|---|---|
| #357 | **0108** | Live | Treatment observation chips — structured, reliable toggle chips on charting | Additive; legacy chips backfilled from `comments` on edit (unedited rows keep unstructured chips) |
| #358 | none | Live | Client-facing SMS uses 12-hour time | Code-only; no schema; no SMS behavior change beyond formatting |
| #359 | **0109** | Live | Studio 12h/24h time-format preference | Additive column, default `12h`; existing studios → 12h; machine values stay 24h |
| #360 | **0110** | Live, **default OFF** | Postcare automation (opt-in auto-send on appointment completion) | Default `manual` = no behavior change on deploy; fail-soft; skipped if Resend key / postcare text missing |
| #361 | none | Live | Calendar action modal renders 12h (respects preference) | Code-only; time-format bug fix |
| #362 | none | Live | Scrollable calendar cards + drag render 12h | Code-only; time-format bug fix |
| #363 | none | Live | Booking drawer: override + exact clicked-time booking | Code-only; no booking-validation weakening |
| #364 | none | Live | Calendar internal scroll + mobile sticky rail (usability) | Code-only; layout |
| #365 | none | Live | Owner-only blocked-time editing from the calendar | Code-only; owner-gated server-side; members read-only |
| #366 | none | Live | Client portal: practitioner "Send portal link" + "Copy login URL" + resend rate limits | Reuses existing hashed/single-use/60-min issuance; studio-scoped; per-practitioner+client 3/hour limit; no raw token exposed |
| #367 | none | Live | Portal CTA in confirmation + reminder emails; login-page expiry copy fix (30m→1h) | Token-free `/portal/login?studio=slug` CTA; no clinical data; enumeration behavior unchanged. NOTE: the portal **verify** page still says "30 minutes" — a follow-up fix |
| #368 | none | Live | Multiple photo upload (per-file validation + EXIF strip + per-file status) | UI-only; server action/sanitize/storage/RLS byte-unchanged; no all-or-nothing, no silent loss |
| #369 | none | Live | Compact marketing-consent UI on public booking | Presentational; default unchecked + never prechecked + consent-send logic unchanged |
| #370 | **0111** | Live | Client portal access events + practitioner status card (last sent / last seen / pending tasks / recent activity) | Append-only, SELECT-only RLS, service-role inserts only; no token/URL/PII columns; fail-soft logging; public login untouched. Merge SHA `7d86d88caa9f6f8578c17f99b05d47a46cd5af63` |
| #371 | none | Live | Public booking "Back to previous result" availability navigation | Client-side history stack; stepping back re-fetches + re-validates that day's slots (no stale booking); server/query/tz unchanged. Merge SHA `f006517440eb3dd11500788510d0b10107835f53` |
| #372 | **0112** | Live | Public booking horizon 1–12 months | CHECK widened `(3,4,6)`→`(1..12)`; default 3 + existing values unchanged; scan cap + recurring-break window derive from a 12-month max so a long horizon never truncates. Merge SHA `2d4b809777d98a33981753312c13bfd40bfe0c92` |

## Migration-first PRs in this wave

The migration-bearing PRs (#357/0108, #359/0109, #360/0110, #370/0111, #372/0112) were shipped
**migration-first**: the migration was applied to production and verified **before** the code
merge/deploy. See [../runbooks/migration-first-process.md](../runbooks/migration-first-process.md).

## Provenance

This changelog was reconstructed at the 2026-07-08 documentation repair from PR reports and
git history; it is not auto-generated. A generated changelog (from `git log` / merged PRs) is
a documentation follow-up.
