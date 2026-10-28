# HON-8: Senior 3G and Junior 3G native contracts

Both exact-model v2 contracts are implemented in `lib/machines/apilus-3g.ts`.
They are registered beside the unchanged v1 contracts, not substituted for them.
No profile or mode has been activated: the standing activation hold remains.
These are manufacturer-documented contracts, not physical-device confirmations.

## Evidence actually checked

Research handoff: https://github.com/SaiSamyukthVemuri/Hone/pull/860#issuecomment-6257228965

Both English PDFs were downloaded and their hashes matched the handoff exactly.
Their operating instructions, screen text and specifications were read directly.
Each field/mode cites its own model's manual and printed page range; no 3G field
borrows xCell evidence. The document identifiers and SHA-256 hashes are retained
in each evidence reference's locator.

- Senior: Dectro 6080-0000349 en20, copyright 2016, pp14–16, 18–22, 36.
  https://academiedectro.com/wp-content/uploads/2021/04/mu_senior-3G_6080-0000349_en20.pdf
- Junior: Dectro 6080-0000345 20EN / 201020, copyright 2016, pp15–20, 31.
  https://academiedectro.com/wp-content/uploads/2021/04/mu_junior_3G_6080-0000345_20EN.pdf

## Implemented native numeric fields

| Model | Mode | Native numeric capture |
|---|---|---|
| Senior | Thermo Flash | H.F. seconds/2, intensity percent/0, pulse count |
| Senior | MicroFlash | H.F. seconds/3, intensity percent/0, pulse count |
| Senior | MultiPlex | Warming H.F. seconds/1 and percent/0; separate MicroFlash seconds/3, percent/0 and pulse count |
| Senior | Blend | H.F. seconds/2, percent/0, pulse count; galvanic seconds/0 and mA/2 |
| Senior | OmniBlend | Galvanic seconds/0, mA/2 and configured MAX HF percent/0 |
| Senior | MultiBlend | Galvanic seconds/0, mA/2, MAX HF percent/0; separate editable final MicroFlash seconds/3 and percent/0 |
| Senior | Electrolysis | Galvanic seconds/0 and mA/2 |
| Junior | Thermolysis | H.F. displayed seconds/1, percent/0, pulse count; time precision explicitly pending |
| Junior | Flash Thermo | H.F. seconds/2, percent/0, pulse count |
| Junior | Blend | H.F. seconds/2, percent/0, pulse count; galvanic seconds/0 and mA/2 |
| Junior | OmniBlend | Galvanic seconds/0, mA/2 and configured maximum H.F. percent/0 |
| Junior | Electrolysis | Galvanic seconds/0 and mA/2 |

The existing shared React field component renders these descriptors for both
create and revision forms. There are no default treatment settings, computed dose,
invented modes, numeric program identifiers or unit conversion. Warming H.F. is
not labelled galvanic. The session timer is not used as application duration.

Historical display now resolves the exact retained profile version for labels
and stage names. Stored reading units, precision, provenance and numbers remain
authoritative. A version missing from the catalogue still falls back to recorded
keys. v1 Senior milliseconds are never converted or relabelled as v2 seconds.

## Narrow remaining gaps

1. **Activation/release:** explicit operator hold remains. The publication dry-run
   still publishes zero contracts. No hosted publication mechanism or migration
   authorization is implied by source implementation.
2. **Starting-current capture:** Senior Blend/OmniBlend/MultiBlend (manual p22)
   and Junior Blend (pp17,20,31) have a documented starting-current choice.
   Frozen 0223 stores numeric readings or reasoned absence, not categorical
   values. Those modes carry `captureHold`, enforced by activation integrity,
   publication and new-capture validation. A readable pending message is rendered.
   A categorical write/read/history contract needs its own additive schema work
   and allocation; no numeric encoding or discarded editable selector is used.
3. **Junior OmniBlend order:** English p20 allows changing it; p31 specifies
   galvanic-first. Identify the installed Junior firmware and inspect that mode's
   starting-current configuration screen. No freely editable Senior selector or
   assumed order is inherited. This mode alone remains held for that conflict.
4. **Junior Thermolysis precision:** identify Junior firmware and obtain its
   Thermolysis time screen/adjustment increment, distinguished from Flash Thermo.
   The screen shows tenths while English prose/specification also says hundredths.
   The time field declares `unverified: ["decimals"]`; the mode remains pending.
5. **Disputed limits, not disputed units:** Senior OmniBlend p20 says 19% while
   p36 says 29%. Junior Electrolysis p16 says 0.99 mA while p31 says 1.99 mA.
   Confirm the matching firmware/manual edition and relevant screen. These are
   scoped discrepancy notes; neither maximum is selected or enforced. The fixed
   RF frequency 13.560 MHz is 13.56 MHz, not a hardware-frequency dispute in v2.
6. **Optional text context:** program identifiers with leading zeros/insulated
   suffix, activation choice and other categorical context cannot be represented
   by a numeric reading. No fake numeric preset or silently discarded field was
   added. Existing general charting/probe context is preserved.
7. **Infinity:** OPS allocated 0235 and the proposal's unchanged SQL body is now
   `supabase/migrations/0235_machine_finite_readings.sql`. Its scoped existing-stack
   DB proof passed; full-chain composition and hosted apply remain unrun/held.
   Frozen 0223 and held 0234 are unchanged. See [the proof record](reviews/hon8-0235-db-proof-2026-10-19.md).

## Test evidence boundaries

The native tests exercise all 12 mode descriptors, actual shared React component
static output, numeric payload round trips, no copied draft values, and retained
v1 history/next-visit rendering. JSON round trips and server rendering are not a
database save, browser reload, mounted interaction or physical-device test.

Executed: 902/902 tests passed across 28 focused unit/component/script files,
including 44 new native-contract and render cases. Typecheck and focused ESLint
passed. A deliberate seconds-to-milliseconds mutation failed three native
contract tests; restoring the exact source returned the suite to green.

| Check | Senior 3G | Junior 3G |
|---|---|---|
| Native field component static render | Passed, all 7 modes | Passed, all 5 modes |
| Numeric payload JSON round trip | Passed, all 7 modes; not a database save | Passed, all 5 modes; not a database save |
| History and next-visit component static render from supplied v2 rows | Passed, all 7 modes | Passed, all 5 modes |
| Historical v1 preservation | Passed: original ms value/labels render without conversion | Passed: v1 identity-only contract remains unchanged |
| Mounted browser UI, desktop/mobile interactions and mode switching | Unrun | Unrun |
| Transaction-scoped DB recording/read-back/history/next-session lookup | Passed, 4 eligible modes | Passed, 2 eligible modes |
| Committed cross-connection reload | Unrun | Unrun |
| Browser save, refresh, reload and next visit | Unrun | Unrun |
| Interrupted-save recovery and deliberate identical new area, including mobile | Unrun for these native contracts | Unrun for these native contracts |

Exact-head independent review and new-head CI are pending. Neither profile is
merged, deployed, physically matched or human accepted by this implementation.

`tests/db/machine-apilus-3g.db.test.ts` adds six real DB cases for the independently
ready numeric modes (Senior Flash/MicroFlash/MultiPlex/Electrolysis; Junior
Flash/Electrolysis). It uses synthetic fixture identities, preserves the reviewed
model's field definitions, and tests recording, repeated read-back, history and
next-visit lookup. All six passed on the owned stack in the granted Machines slot.
The existing role helper rolls each test transaction back, so this proves database
command behavior, not committed durability or a fresh browser/connection reload.
No real model was activated. Native browser save/reload/next-visit and mobile
recovery proof remain unrun; no previous synthetic demo result is claimed as evidence
for these model contracts. The stack is stopped with volumes preserved and slot released.

All production/provider/customer-data restrictions remain. #926 is evidence-only;
#920/0234 stays held. No hosted apply, production merge/deploy, demo or server start.
