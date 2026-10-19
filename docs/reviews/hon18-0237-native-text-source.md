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
