# HON-8 native mounted proof preparation

Status: **UNRUN for both models**, desktop and mobile. This is an execution plan,
not browser evidence. OPS accepted the scoped 10/10 DB proof and zero-delta shared
census; Photos now owns the heavy slot. No DB, browser, build, reset or start is
authorized by this plan. A new explicit slot grant is required.

## Existing paths to extend

Use `e2e/machine-create-mode-journey.spec.ts` for the native journey, with its
existing `registerMachine`, `openCreateForm`, `openMachinePanel`, `capturesFor`,
`readingsFor`, `blockIdOf` and `noOverflow` patterns. Reuse
`e2e/helpers/seed.ts` and `e2e/helpers/flows.ts`; do not create a harness. Use the
same-client app-created next visit pattern from steps 10b/11b, including aging
fixture sessions past the 90-minute reuse window. A new seeded client is not a
next visit. Reuse failure/retry patterns from
`e2e/machine-initial-save-retry.spec.ts` and switching patterns from
`e2e/machine-switch-discards-draft.spec.ts` where applicable.

Run each native case at desktop 1280×800 and mobile 390×844 (mobile touch enabled).
The current create-mode spec sets mobile globally; desktop must override that
inside its own describe scope, without changing the existing mobile journey.

| Model / v2 mode | Desktop journey | Mobile journey |
|---|---|---|
| Senior Flash | UNRUN | UNRUN |
| Senior MicroFlash | UNRUN | UNRUN |
| Senior MultiPlex | UNRUN | UNRUN |
| Senior Electrolysis | UNRUN | UNRUN |
| Junior Flash | UNRUN | UNRUN |
| Junior Electrolysis | UNRUN | UNRUN |

Use the exact field/stage definitions from `lib/machines/apilus-3g.ts`, traversed
with `modeFields`, and the eligible-case selection in
`tests/db/machine-apilus-3g.db.test.ts`. Do not copy Senior definitions into Junior.
Use distinct values per field and explicit stage/field assertions, including
MultiPlex warming fields. Preserve unit, precision, source and version assertions;
never infer a new unit, rounding rule, mode or categorical encoding.

## Implemented fixture and executable-case source

`lib/machines/apilus-3g-fixtures.ts` derives separate synthetic Senior and Junior
identities from the reviewed v2 contracts. Its explicit mode allowlists expose
only Senior Flash/MicroFlash/MultiPlex/Electrolysis and Junior Flash/Electrolysis.
Field/stage definitions are deep-cloned, with no invented units or precision.
It refuses retained held fields or unresolved questions. The real contracts remain
blocked. `catalogueForRuntime` appends these fixtures only through the existing
server-only, explicitly enabled, local and undeployed gate; no new flag or harness.

The existing create-mode journey now contains 12 executable native cases: six
model/mode combinations at each viewport. They publish synthetic contracts through
the existing command, seed units with existing SQL helpers, save observations
through the app, compare committed rows using separate SQL calls, reload history,
check empty observation controls, and create a distinct same-client next visit
through the app with exact per-field guidance assertions. They preserve the stored
capture and rows across reload and next visit. They are authored source, **not
executed browser evidence**. Closed-gate cases explicitly skip as UNRUN; enabled
cases fail if the server lacks the fixture. Revision/change and retry extensions
in the assertion checklist below remain additional outstanding coverage; the new
12 cases cover the initial durable save/reload/next-visit chain.

Targeted gate tests cover disabled/non-exact flags, nonlocal targets and deployed
signals, native field equality, separate identities and publication eligibility.
Runtime prerequisites are now a later slot grant, exact-head composed owned stack,
existing server environment forwarding and the readiness/containment checks below.
No fixture source extension is still required for the authored 12 cases.

The flag must reach the existing Next server environment through
`E2E_WEB_SERVER_ENV`, not merely the Playwright process. Keep tracked ports/config
unchanged. A gate-closed result proves containment only; it cannot count as native
journey acceptance. Unexpected missing fixture options in a gate-open native case
must fail rather than return early and report a pass.

## Assertions required for every matrix cell

1. Mount the create form, select the synthetic native unit and exact mode; assert
   native labels, units, steps/precision and stage grouping, and no horizontal
   overflow. Assert held/disputed modes are unavailable for capture.
2. Fill every required field, save through the mounted application, poll the
   created block/capture, and compare exact stored native rows, version, source
   and submission identity. Do not seed the readings being proved.
3. Reload the page and reopen the block. Assert persisted history labels/units/
   values use the saved version; new observation controls remain empty. Read via
   a separate SQL call after the app transaction commits. This supplies the
   durability boundary absent from rollback-scoped DB tests.
4. Record a changed reading through the UI; verify the original revision stays
   unchanged, the new revision is attributed correctly, and reload shows both.
5. Start the same client's next visit through the app, assert a distinct session,
   open the native panel and inspect exact prior-field locators. Latest guidance
   must carry the correct model/mode/version/native values without becoming new
   observations or mutating historical rows.
6. Exercise mounted failure/retry with existing helpers; verify no partial
   submission or duplicate captures. Keep browser and storage assertions paired.

## Readiness and evidence required before execution

After a new grant, record START with exact committed source and patch SHA,
CLI/container identity and paired owned API/SQL target, existing outbound/mail
and provider guards, shared frozen-stack census and migration composition. The
previous owned stack is stopped with volumes preserved; do not restart it while
Photos holds the slot. Verify prerequisites before any fixture writes. Do not
claim a fresh-chain reset or missing train composition from the scoped 0235 apply.
Record per-case results and exact commands, gate state and fixture identities,
then shared census and normal END/slot release. If prerequisites fail, record the
precise blocker and release normally; leave affected cells UNRUN.

Physical checks, categorical storage, disputed modes and real activation stay
held. Frozen 0223 and #920/0234 remain untouched; #926 is evidence-only. #931 is
resolved at e102d816 and is not a prerequisite. Production, hosted migration,
provider, customer-data and release holds remain; demo stays off.

## Source-only validation for fixture implementation

Targeted lightweight suite: **165/165 passed in six files** (native fixture gate,
native contracts/components, existing machine draft and E2E fixture/environment
guards). The final unit-fixture environment typing correction was followed by an
additional **11/11 native-fixture tests passed**. Typecheck and focused ESLint **passed**. No Playwright collection/execution,
build, DB, reset or stack start was performed. The earlier DB10/10 is unchanged
historical scoped evidence, not a run of these browser cases.
