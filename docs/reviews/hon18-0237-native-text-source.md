# HON-18 / 0237 native text and categorical source

OPS allocated 0237 to the existing Machines branch for faithful Senior 3G and
Junior 3G text/choice storage. This is T3 clinical contract/schema work. Source
and lightweight proof are provided here; **0237 SQL, DB and browser proof are
UNRUN pending OPS target/candidate approval and a shared heavy-slot grant**.
No production, hosted migration, real activation, provider or customer-data action
is authorized. Frozen 0223/0235, Team 0236 and held #920/0234 are unchanged.

## Contract and preservation

Separate **v3** model contracts retain original v1/v2 definitions. Each model has
an optional text `program_identifier`, transcribed without numeric conversion,
trimming, padding, leading-zero removal or inferred preset values. Manufacturer
sources are the already-reviewed Senior en20 manual pp22–25 and Junior 20EN manual
pp20,23, with their existing SHA256 evidence records in `apilus-3g.ts`.

Senior Blend, OmniBlend and MultiBlend add required `starting_current` choices
`Glv Hf` / `Hf Glv` from its Operation screen on p22. Junior Blend independently
uses `Glv hf` / `Hf Glv` from its Configuration screen on p20. These are native
text choices, not numeric enums or actuator instructions. Only v3 removes those
numeric-storage capture holds. Junior OmniBlend retains its contradictory
starting-order hold; Junior Thermolysis retains its unresolved precision. Disputed
Senior OmniBlend/Junior Electrolysis maxima remain notes, not enforced limits.
Every real profile and mode remains blocked; complete field evidence is not
Sam's activation authority or physical-device acceptance.

`valueKind` defaults to the historic numeric contract. Text/choice fields use
unit `none` and decimals zero as nonnumeric storage sentinels, not invented units
or precision. Text is bounded to 500 Unicode characters as a transport/storage
limit, not a device or therapeutic limit. Empty text and NUL are refused; a blank
optional UI field creates no observation. A reasoned absence remains distinct.

0237 adds nullable `value_text`, numeric-default field-contract type metadata and
choice metadata. Exactly one number, text or reasoned absence is stored. The
existing shared writer derives type/choice membership from the immutable contract;
its scope/identity/channel/revision locks and required-field checks are preserved.
Both immutable publication comparisons include type and choices. The existing
single-statement read and same-client next-visit read project text. Initial atomic
save, group save and submission save all serialize exact strings. Existing retry
digests already cover the entire JSON payload and require no replacement.

The migration replaces four existing function bodies, without signature changes
or a new API/tool. All runtime-role EXECUTE grants are explicitly revoked by name
then restored only as before: publisher service_role, reads authenticated, shared
writer internal-only. Clinical table ACLs/RLS, append-only triggers, capture FKs
and the finite constraint remain intact. No historical observation is rewritten.
Apply schema before application capture of v3; real activation stays held until
review, proof, rollout and Sam's separate decision. An old app must never be
activated against a text-enabled real contract it cannot render.

## Existing synthetic proof path

Two additional v3 synthetic fixture identities use the existing server-only,
local, undeployed `HONE_SYNTHETIC_MACHINE_PROFILE=1` gate. The original four
synthetic identities, including v2 native fixtures, remain intact; exact six-ID
containment and real-profile identity/availability tests cover the new set.
New fixtures are `synthetic:native-senior-3g-text` and
`synthetic:native-junior-3g-text`. They do not assert physical behavior.

The existing `machine-apilus-3g.db.test.ts` prepares **four new cases** (Senior
Blend/OmniBlend/MultiBlend; Junior Blend) using the existing role/seed helpers:
exact program text, both native choices, changed-contract refusal, idempotent
publication, invalid-choice rollback, immutable original revision and next-visit
lookup. They do not self-apply SQL and remain UNRUN.

The existing create-mode spec prepares **eight new browser cells**, these four
modes × desktop/mobile, under the separate selector:

```sh
npx playwright test e2e/machine-create-mode-journey.spec.ts \
  --project=chromium --grep 'native 3G text durability'
```

It reuses the same seed/login/form/publication/readback helpers and requires the
existing synthetic flag forwarded to the server. It checks native text/select
controls, mixed numeric/text app save, separate-connection committed readback,
reload/history, empty fresh controls and a distinct app-created same-client next
visit. Gate-closed skips are **not** acceptance. Native browser revision/retry
recovery remains an explicit additional gap. No new flag, harness or demo run.

Historical **DB202/native12 at d122c8eb** proves the previous numeric scope only.
It does not prove 0237, these v3 contracts or this new source head. Full-chain
composition must include Team 0236 and 0237; this owner branch does not invent or
copy the missing train. OPS owns the exact composed candidate and target.

## Separate physical/firmware acceptance requests for Sam

- **Senior:** exact model/firmware and matching manual edition; readable native
  Flash/MicroFlash/MultiPlex warming+fast stages/Electrolysis screens; Operation
  starting-current screen for Blend/OmniBlend/MultiBlend showing both native
  choices; program display including identifier formatting; evidence resolving
  OmniBlend 19%/29% discrepancy. No guessed hard maximum.
- **Junior:** its own model/firmware/manual edition; Flash and Electrolysis
  screens; Blend starting-current Configuration choices; OmniBlend order screen
  to resolve p20/p31 conflict; Thermolysis time digits/observed increment,
  distinguished from Flash; native program display; Electrolysis0.99/1.99mA
  discrepancy evidence. No sibling-model inheritance.

These are model-specific acceptance requests, not blanket implementation blockers.
No physical check or equipment actuation has been performed. Categorical context
beyond these confirmed fields (including unverified activation/context selectors)
is not invented or silently stored as a number. Sam retains privileged
publication/write, real activation, hosted migration, merge/deploy/release authority.

## Executed lightweight checks

- Affected Machines unit/component/app/operator-entry/static suite: **1040/1040**
  across 33 files after correcting two stale version/readiness assertions.
- Existing clinical RPC ACL, E2E fixture/environment and frozen migration guards:
  **108/108** across five files.
- Final native text/initial-save/0237 static checks: **48/48** across three files,
  including malformed choice metadata negative controls. Counts overlap with the
  affected-suite run and must not be added as a unique test total.
- Typecheck and focused ESLint passed. Native DB cases are source-prepared/typechecked,
  not executed. No Playwright collection, app build, reset or server start ran.

Complete outputs and initial fixture/test failures are retained under the external
Machines handoff directory as `0237-*.txt`. The target/candidate request is
`0237-target-candidate-proof-request.json`; a proposed owned pair is not a slot
or reset grant. Full unit CI, independent schema/source review, composed full-chain
and 0237 DB/browser evidence remain outstanding before any release decision.


## 2026-10-20 focused mode coverage and acceptance boundaries

The existing lightweight native-text suite now exercises the actual field groups
for Senior Blend, OmniBlend and MultiBlend separately, and Junior Blend
independently. Both native choice strings pass through draft assembly, exact
program text (including surrounding spaces), native validation and publication
metadata. Wrong-model choice spelling is refused. Junior OmniBlend stays absent
from the synthetic publication set and retains its current-order hold; real
profiles remain blocked. These are unit checks, not mounted browser or device
acceptance. The focused native-text plus 0237 source-contract suites pass
**43/43** (39 + 4); earlier totals above are historical, overlapping evidence.

Remote CI39349144127 at adfa751 passed **3842/3842 DB tests**, including the six
numeric and four categorical native cases; its six canonical-production-facts
unit failures remain a separate lineage/record dependency. This remote receipt
does not close the local integrated full-chain, native browser or device gaps
marked UNRUN above. Exact review at adfa751 found no major issues.

For **Senior**, Sam can provide existing model-label/firmware/manual-edition
images, then separate mode-labelled Operation screens for Blend, OmniBlend and
MultiBlend showing the starting-current options and literal program display.
Record the displayed units/digits and MultiPlex stage labels independently. Keep
the OmniBlend 19%/29% discrepancy explicit until matching evidence resolves it.
No treatment actuation or customer record is needed for this evidence request.

For **Junior**, obtain its own model-label/firmware/manual-edition images and
Blend Configuration screen with its own exact choice labels and program display.
Request a separate OmniBlend screen/manufacturer clarification: the same Junior
manual p20 allows starting-current changes in Blend or OmniBlend, while p31 says
OmniBlend is galvanic-first. Its p19 simultaneous-current description does not
resolve editability. Keep that mode isolated; separately request Thermolysis
digits/increment versus Flash and the Electrolysis 0.99/1.99 mA discrepancy.
Do not substitute Senior observations for Junior evidence.

The existing eight v3 browser cells remain **UNRUN** (Senior six, Junior two):
mounted desktop/mobile controls, save, committed readback, reload/history and a
distinct same-client next visit require OPS's exact integrated candidate, verified
owned target and explicit slot grant. Native revision/retry and physical/firmware
acceptance remain separate UNRUN gaps. No activation or privileged publication
follows from any of these source or synthetic checks.


## Exact text whitespace rendering repair

Review of 96075c85 found that normal inline HTML collapsed accepted identifier
whitespace even though the stored string remained exact. Text values now use
whitespace-preserving wrapping in recorded history, both sides of the change
summary and previous-treatment guidance. Numeric precision/unit and reasoned
absence formatting are unchanged. Regressions cover surrounding/repeated spaces,
tabs and newlines independently for Senior and Junior. The focused native-text,
recorded/prior component, chronology and 0237 source-contract suites pass
**144/144** across four files. This establishes rendering markup and CSS intent;
actual mounted browser/mobile layout remains UNRUN pending the existing OPS gate.
No payload, model contract, SQL, publication or activation behavior changed.


## Exact native text/choice interrupted-save preparation

Confirmed native fields are implemented for both models; missing physical unit
identifiers do not block this source work. Existing tests now exercise the
submission adapter and save state machine for Senior Blend/OmniBlend/MultiBlend
and Junior Blend separately, using each choice string and exact program text
` 003i `. An unknown transport answer keeps the draft frozen and the same retry
identity; retry sends identical JSON, and a simulated reused receipt settles the
state. An intentional later capture may keep identical values with a new key.
This is mocked adapter/state proof, not database deduplication or mounted recovery.
The focused native-text/save-attempt/initial-save receipt/resume-choice/0237
source suites pass **126/126** across five existing files (overlapping prior
counts). No runtime, payload, SQL, model contract or activation change was needed.

The future native interrupted-save check must reuse the pattern in
`e2e/machine-initial-save-retry.spec.ts`: perform the original server request
before dropping its response, then independently prove the first commit exists.
Aborting before the request reaches the server is not this failure case. For
each model, preserve the exact program/choice/numeric payload and retry identity,
verify frozen controls, retry unchanged and require the original area/submission/
capture and unchanged row counts. Continue through committed reload, history,
distinct next visit and mobile; keep the separate resume-after-reload case
explicitly UNRUN until exercised. The existing numeric retry spec is not an
executed native-text retry case, and no native retry browser case was added or run.

On reload, an unresolved operation identity must remain protected. Use the
existing recovery choice and full-area reconstruction confirmation when required;
restore the complete original area/entry/settings payload, not only the machine
fields. A missing or uncertain lookup is not proof of a failed write. Only an
authoritative receipt settles the earlier save; a deliberate second area uses the
existing explicit new-area choice. Record first/retry/after-reload identities and
counts as receipts, without interpreting a unit mock as a committed database result.

These prepared steps require an aligned current integrated candidate, verified
isolated target and explicit OPS slot. They authorize no stack/device run,
hosted application, publication, activation or deployment. Sam must separately
supply exact Senior and Junior model/firmware references and named qualified
operator/reviewer for physical acceptance; all actual physical proof remains UNRUN.


## Retained native field/stage order in history and next-visit guidance

The source audit confirmed a display gap: chronology sorts field keys, and the
SQL read projections also use key order. Grouping those rows in received order
can put Senior MultiPlex's MicroFlash stage before warming and reorder native
fields in both models' text/choice modes. History and prior guidance now project
known readings in the retained exact-version mode's field/stage order. They do
not use the latest contract to reinterpret an older reading. Unknown fields stay
visible in received relative order; a missing retained contract preserves the
received order rather than inventing a native sequence. Sorting copies leaves
all observations and chronology records unchanged.

Five source-driven rendering regressions failed before the fix. They cover
Senior Blend/OmniBlend/MultiBlend, Junior Blend and Senior MultiPlex warming
before MicroFlash, including a differently ordered newer contract as a negative
control. The focused existing native-text, recorded/prior component, chronology,
save/recovery, initial receipt and 0237 source suites pass **224/224** across
seven files. This proves source/rendering behavior, not a mounted browser or a
physical unit's installed firmware. No field/unit/precision/bound/choice, storage,
SQL, historical record, publication or activation contract changed.

## Native mounted recovery and exact rendered values — source prepared

The existing twenty native durability cases now include the initial-save lost
response and retry, using the existing initial-save-retry spec's interception
pattern. Senior retains fourteen cells (eight numeric, six text/choice); Junior
retains six (four numeric, two text/choice), each split across desktop and mobile.
No fixture identity, manufacturer contract, SQL, gate or harness changes.

Every case now performs the original request before aborting only its response,
requires the unknown-outcome UI, independently reads the committed observations
and all original session block/submission/capture/reading/claim identities, then
checks every native control is disabled. Forced DOM changes exercise the existing
handler guard. Retry must settle with precisely the original identities, rows
and capture metadata; new-key duplication anywhere in the session fails. The
same snapshots must survive reload/history and a distinct app-created next visit.
This covers same-mount initial-save recovery; reload while the outcome remains
unknown and later revision-response loss are separate, unexecuted acceptance gaps.

For each confirmed choice mode, desktop selects the first native choice and
mobile the second. Mobile transcribes ` 003i ` literally; desktop retains `003i`.
History and prior guidance now assert each value's exact `textContent`, nonnumeric
`white-space: break-spaces`, retained native field order and stage headings. This
avoids substring or whitespace-normalizing assertions passing a wrong field or
collapsed string. These synthetic values establish no physical program format.
Both choices are covered across the two viewports, not both in each viewport.

The existing native text unit tests now additionally render both frozen and
editable shared controls for both choices in Senior Blend/OmniBlend/MultiBlend
and Junior Blend. All native inputs/selects must match the freeze while retaining
exact program/choice values. Focused existing native/recovery/environment units
passed 139/139 across five files; TypeScript and focused ESLint passed. These
checks verify source and unit behavior only. No Playwright collection, DB/browser,
build, server, reset, migration application or slot claim ran. All twenty extended
mounted cells remain UNRUN until OPS supplies an aligned candidate, compliant
isolated target and explicit shared-slot grant. Physical model/firmware evidence
and named qualified operator/independent reviewer remain separate inputs from Sam.

## Native reload-while-unknown and revision response loss — source prepared

The same existing twenty native cases now reach the two remaining recovery paths,
without new fixtures, modes, workers or a harness. Desktop's ten cells retain
same-mount initial-save retry. Mobile's ten cells instead reload while the initial
save outcome is still unknown: the URL's `area_op` must match the independently
read committed claim, survive reload, resolve to the original block, disable a
second save and clear the settled identity. Closing the reconciliation notice
must leave every original block/submission/capture/reading/claim unchanged. This
is the committed-but-response-lost branch; an uncommitted/unknown claim still
needing full draft reconstruction is a different case and is not proved here.

All twenty cells then enter a genuine later setting change through the existing
revision controls, changing native numbers and, where present, Program text and
the starting-current choice. The revision commits before its response is lost.
The test independently verifies exactly one new submission/capture and its exact
values while preserving the original capture/rows. Native fields, machine and
all mode buttons must be frozen; mode counts are asserted to avoid a vacuous
identity-freeze loop. Forced DOM edits exercise the existing handler guard.
Retry must settle without any new identities, row changes or third capture.

A subsequent reload must show both immutable captures, with each capture's own
exact values/whitespace and native field/stage order. A distinct app-created next
visit must offer the revised values, not the initial capture, while new inputs
remain blank and all original-session identities/rows stay unchanged. The SQL
snapshot uses a stable row-ID tie-breaker when revisions share field/stage keys.
This gives per-mode mobile initial-unknown reload and desktop/mobile revision
retry coverage; initial-unknown reload on desktop remains outside this matrix.

Relevant existing lightweight recovery/state/shared-control tests passed 63/63
across three files; TypeScript and focused ESLint passed. The earlier 139-pass
suite was not rerun or added to this count. No DB/browser collection/run, build,
stack/start/reset, SQL change, apply, activation or slot claim occurred. These are
executable assertions prepared from the current contracts, not executed mounted
proof. All twenty updated cells remain UNRUN pending OPS's aligned candidate,
verified compliant target and explicit slot. Physical Senior/Junior unit/firmware
and named operator/independent reviewer acceptance remains separate and UNRUN.
