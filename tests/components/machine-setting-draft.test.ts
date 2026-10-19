import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import type { MachineProfile } from "@/lib/machines/profile-contract";

// ===========================================================================
// COLLECTING MACHINE SETTINGS WHEN THERE IS NO BLOCK YET.
//
// WHAT CHANGED. Until now the create form refused to collect a reading it had
// nowhere to put: a new settings block has no row, so the panel showed the
// model's field contract read-only and the practitioner saved the area,
// re-opened it, and recorded. Two steps for one act.
//
// `create_block_with_initial_setup` (0223) writes the area and the settings in
// ONE transaction, so there is now somewhere to put them. This collects them
// for that save - and saves nothing itself.
//
// THE SQL HAS NOT RUN. 0223 is pending; the behavioural specification is
// tests/db/machine-setup-submission.db.test.ts and it has not executed. What
// is proved here is the RENDER and the SHAPE of the handoff.
// ===========================================================================

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { MachineSettingDraft, MachineSettingDraftReset } = await import(
  "@/components/machines/machine-setting-draft"
);

const PROFILE = {
  profileId: "fixture:draft",
  version: 1,
  family: "Synthetic/Demo",
  manufacturer: "Fixture",
  model: "Draft",
  availability: "active",
  verification: "device-confirmed",
  frequency: { kind: "not-applicable" },
  channels: {
    count: 2,
    nativeLabel: "Probe",
    associationRequired: false,
    supportsDistinctSettingGroups: true,
    verification: "device-confirmed",
    evidence: [],
  },
  evidence: [],
  modes: [
    {
      key: "galvanic",
      nativeLabel: "Galvanic",
      stages: [],
      fields: [
        {
          key: "current",
          nativeLabel: "Current",
          unit: "µA",
          decimals: 0,
          quantity: "current",
          scope: "per-channel",
          optional: false,
          editable: true,
          source: "practitioner-entered",
          advisory: [],
        },
      ],
    },
  ],
} as unknown as MachineProfile;

const html = renderToStaticMarkup(
  createElement(MachineSettingDraft, {
    profile: PROFILE,
    mode: PROFILE.modes[0]!,
    onDraftChange: () => {},
  }),
);

/**
 * The expression a `const <name> = ...;` is assigned, with comments already
 * stripped by `read`.
 *
 * Guards below assert what a freeze is DERIVED FROM rather than how it is
 * spelled. Matching the literal expression is what made four guards in this
 * file go red on the fix for #860 4305022475 while staying green on the
 * defect: they pinned the exact text that was missing the in-flight window.
 */
function assignedExpression(src: string, name: string): string {
  const m = new RegExp(`const ${name}\\s*=\\s*([^;]+);`).exec(src);
  if (!m) throw new Error(`no 'const ${name} = ...;' in source`);
  return m[1]!;
}

describe("the create-mode collector", () => {
  it("renders the machine's own fields", () => {
    // THE SAME COMPONENT the entry form uses, which is the point of having
    // extracted it: one definition of what the contract says a reading is.
    expect(html).toContain('data-testid="machine-setting-draft"');
    expect(html).toContain('data-testid="field-label-current"');
    expect(html).toContain("(µA)");
    expect(html).toContain('data-testid="reading-current"');
  });

  it("SAYS that these save with the treatment area", () => {
    // The difference from the entry form is not visible in the fields. With
    // no block there is no separate Save to press, so without this line she
    // has no way to know whether the area's Save carries them.
    expect(html).toContain('data-testid="setting-draft-note"');
    expect(html).toMatch(/saved together with the treatment area/i);
    expect(html).toMatch(/one save/i);
  });

  it("offers NO save control of its own", () => {
    // It saves nothing. The host form's Save is the only one, and a second
    // button would be a second way to do one thing - with no block to record
    // against, it could not work anyway.
    expect(html).not.toContain('data-testid="machine-reading-save"');
    expect(html).not.toContain("Save these settings");
    expect(html).not.toContain('data-testid="machine-reading-saved"');
  });

  it("starts EMPTY, so nothing can be recorded unread", () => {
    // A value she has not read off the machine is not a reading, and the
    // record must not be able to acquire one by her failing to notice a
    // filled box.
    const input = (html.match(/<input[^>]*>/g) ?? []).find((t) =>
      t.includes('data-testid="reading-current"'),
    );
    expect(input, "no entry input was rendered").toBeTruthy();
    expect(input).not.toMatch(/value="[^"]+"/);
  });
});

describe("the handoff's shape, pinned on source", () => {
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../..", rel), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      " ",
    );

  const DRAFT = "components/machines/machine-setting-draft.tsx";
  const PANEL = "components/machines/machine-first-setup-panel.tsx";
  const CONN = "components/machines/machine-first-setup-connected.tsx";
  const FORM = "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";

  it("reports the NEXT draft, not the current state", () => {
    // `setGroups` has not applied when the report runs, so reporting from
    // state would always be one keystroke behind and the host would save the
    // previous values. The report is computed from the candidate.
    const src = read(DRAFT);
    expect(src).toMatch(/const report = \(next: SettingGroupDraft\[\]\)/);
    expect(src).toMatch(/const next = f\(prev\);\s*\n\s*report\(next\);/);
  });

  it("assembles the groups so the host does not reimplement it", () => {
    expect(read(DRAFT)).toMatch(/assembleGroupSubmissions\(fieldGroups, next\)/);
  });

  it("delegates WHY a draft blocks to the shared rule", () => {
    // It computed this inline until a negative control caught it: "a
    // half-finished draft is reported as ready" could be mutated in and every
    // test stayed green, because a static render cannot type into a field.
    // The rule is `draftBlocking` in lib/machines/setting-groups.ts and is
    // proved directly in tests/lib/machines/setting-groups.test.ts.
    const src = read(DRAFT);
    expect(src).toMatch(/draftBlocking\(profile, fieldGroups, next\)/);
    expect(
      src,
      "the rule must not be reimplemented here",
    ).not.toMatch(/missing a required field/);
  });

  it("the PANEL renders it only when there is no block AND a host to carry it", () => {
    // Three arms. Without a host that can carry a draft the panel still shows
    // the contract read-only, because it must never collect a reading it has
    // nowhere to put.
    expect(read(PANEL)).toMatch(/!blockId && onSettingDraft && mode \?/);
  });

  it("the PANEL supplies the identity, which the collector cannot know", () => {
    // The collector has the profile and the mode but not which physical unit
    // is chosen, and the host needs all four: a draft typed under one machine
    // and saved under another is numbers she never read off anything.
    const src = read(PANEL);
    expect(src).toMatch(/deviceId: chosen\.device\.deviceId/);
    expect(src).toMatch(/profileVersion: chosen\.profile\.version/);
    expect(src).toMatch(/modeKey: mode\.key/);
  });

  it("the WRAPPER forwards it — the step that made two features inert", () => {
    expect(read(CONN)).toMatch(/onSettingDraft=\{onSettingDraft\}/);
  });

  it("the FORM supplies it ONLY in create mode", () => {
    // On an existing block the panel records directly, so the two paths must
    // never both be live.
    // THE HANDLER, not the setter. It wraps `setMachineDraft` to drop the open
    // retry key - a changed draft is a different save - which is a rule the
    // bare setter cannot carry.
    expect(read(FORM)).toMatch(
      /onSettingDraft=\{block \? undefined : onSettingDraftChanged\}/,
    );
    expect(read(FORM)).toMatch(/setMachineDraft\(next\)/);
  });

  it("the FORM refuses to save a half-finished draft", () => {
    // Skipping it would discard numbers she typed; sending it would be
    // refused by the command after a round trip.
    const src = read(FORM);
    expect(src).toMatch(/if \(machineDraft\?\.blocking\)/);
    expect(src).toMatch(/setError\(machineDraft\.blocking\)/);
  });

  it("the FORM OFFERS the retry, and keeps its key alive to make it safe", () => {
    // THIS ASSERTED THE OPPOSITE: that the form refused a second attempt,
    // because a repeated INITIAL save created a second treatment area - the
    // submission key is scoped per BLOCK and this path creates the block
    // first. That was measured, not cautious, and it is why
    // treatment_area_create_claims exists: the key is anchored to the SESSION
    // now, so the repeat is absorbed.
    //
    // WHAT MUST BE TRUE INSTEAD, and all three parts matter:
    const src = read(FORM);
    //   1. the unresolved state still reports itself, so she is told;
    expect(src).toMatch(/INITIAL_SAVE_UNRESOLVED/);
    expect(src).toMatch(/setSaveUnresolved\(true\)/);
    //   2. the early return that refused the retry is GONE;
    expect(src, "the form still refuses the retry").not.toMatch(
      /if \(saveUnresolved\) \{\s*setError/,
    );
    //   3. and the key is HELD across attempts rather than minted per attempt,
    //      which is the only thing that makes the retry safe. A fresh key per
    //      attempt would leave every test here passing and the hole open.
    expect(src).toMatch(/pendingSaveKey \?\? crypto\.randomUUID\(\)/);
    expect(src).toMatch(/prepareHandoff\(identity, chosen\.groups, \(\) => key\)/);
    //   ...and dropped on an acknowledged success, or a deliberate second area
    //      would be answered with the first one.
    expect(src).toMatch(/setPendingSaveKey\(null\)/);
  });

  it("the FORM keeps the key through a draft change ONLY while unresolved", () => {
    // The two halves of the key's lifetime, and they pull in opposite
    // directions: a changed draft is a DIFFERENT save, so the key is dropped -
    // except while an attempt is unresolved, where dropping it would turn the
    // retry into a second treatment area. A remount reporting an empty draft
    // is exactly such a change.
    // THE RESUME READ OWNS THE KEY WHILE IT IS IN FLIGHT (A1b). The
    // collector reports an EMPTY draft on mount, which arrives before the
    // claim read resolves, so this drop is held for the width of that round
    // trip -- otherwise the parameter would leave the URL and a reload inside
    // the window would lose the save's identity. Asserted on both terms
    // rather than on the exact expression.
    const drop = read(FORM).match(/if \(([^)]*)\) setPendingSaveKey\(null\)/);
    expect(drop, "the draft-change drop site was not found").toBeTruthy();
    expect(drop![1]).toContain("!saveUnresolved");
    // AND NOT WHILE THE RESUMED OPERATION OWNS IT — in flight, or failed and
    // therefore unanswerable (A1b, Codex #922 4305431332).
    expect(drop![1]).toContain("!resumeOwnsKey");
  });

  it("the FORM computes the settings ONCE per attempt", () => {
    // Calling `machineSetupForSave()` again in the catch would mint a SECOND
    // retry key for the same save - the defect the key exists to prevent.
    const src = read(FORM);
    expect((src.match(/machineSetupForSave\(\)/g) ?? []).length).toBe(1);
    expect(src).toMatch(/const attachedSetup = machineSetupForSave\(\)/);
    expect(src).toMatch(/initialSetup: attachedSetup/);
  });

  it("the FORM mints the retry key ONCE, through prepareHandoff", () => {
    // Minting per attempt would make every retry a new save; never minting a
    // new one would make a deliberate second capture impossible. And
    // `prepareHandoff` COPIES the groups, so a keystroke landing after the
    // save began cannot change what is recorded under the same key.
    const src = read(FORM);
    expect(src).toMatch(/prepareHandoff\(identity, chosen\.groups,/);
    // The payload now reaches the action through `attachedSetup`, which is
    // computed once per attempt - see the case above. Asserting the inline
    // call here would contradict that.
    expect(src).toMatch(/initialSetup: attachedSetup/);
    expect((src.match(/randomUUID/g) ?? []).length).toBe(1);
  });
});
// ---------------------------------------------------------------------------
// A MACHINE OR MODE SWITCH MUST NOT LEAVE A STALE DRAFT LIVE
// (Codex, db3373bc P1)
//
// The panel remounts the collector when the setup identity changes, so ITS
// state resets - but the host form holds the draft it was last told about, and
// the collector said nothing until her first keystroke. Switch machine, press
// Save, and the form sends the PREVIOUS machine's values: numbers she never
// read off the unit now chosen, recorded permanently and unamendably.
//
// TWO SHAPES, TWO FIXES. A remount announces itself with an empty draft, and
// when no collector renders at all - no machine chosen, or no mode resolved -
// the panel clears the host's draft instead.
//
// NEITHER IS PROVABLE BY STATIC RENDER, because both are effects. They are
// pinned on source here and proved MOUNTED in
// e2e/machine-create-mode-journey.spec.ts, which switches away and back and
// then saves.
// ---------------------------------------------------------------------------
describe("switching machine or mode clears the collected draft", () => {
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../..", rel), "utf8").replace(
      /^\s*(\/\/|\*|\/\*).*$/gm,
      " ",
    );
  const DRAFT_SRC = "components/machines/machine-setting-draft.tsx";
  const PANEL_SRC = "components/machines/machine-first-setup-panel.tsx";
  const ENTRY_SRC = "components/machines/machine-reading-entry.tsx";
  const FIELDS_SRC = "components/machines/setting-draft-fields.tsx";
  const CONN_SRC = "components/machines/machine-first-setup-connected.tsx";
  const PRIOR_SRC = "components/machines/machine-prior-setup.tsx";
  const QUERIES_SRC = "lib/machines/machine-queries.ts";
  const SAVE_ATTEMPT_SRC = "lib/machines/save-attempt.ts";
  const MIGRATION_SRC =
    "supabase/migrations/0223_machine_inventory_and_setup_readings.sql";
  const SYNTH_SRC = "lib/machines/synthetic-profile.ts";
  const LOCAL_ENV_SRC = "e2e/helpers/local-env.ts";
  const SETUP_ACTIONS_SRC =
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts";
  const ACTIONS_SRC =
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts";
  const FORM_SRC =
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";

  it("the collector reports an EMPTY draft on mount", () => {
    const src = read(DRAFT_SRC);
    expect(src).toMatch(
      /useEffect\(\(\) => \{\s*onDraftChange\(\{ groups: \[\], blocking: null \}\);/,
    );
  });

  it("reports on MOUNT ONLY, not on every render", () => {
    // The key gives each identity its own mount, so one report per mount is
    // one per identity. An effect keyed on the draft would fire on a
    // re-render and clear values she was still typing.
    //
    // MY FIRST SPELLING OF THIS WAS VACUOUS TWICE OVER, and the negative
    // control caught it: it took `src.indexOf("useEffect")`, which finds the
    // RESET's effect rather than the collector's, and then sliced up to
    // `indexOf("}, [") + 4` and asserted the result ENDS in `}, [` - which it
    // always does, by construction. Changing the collector's deps to
    // `[groups]` left it green.
    //
    // Anchored on the call itself now, so it is the collector's effect being
    // measured and the dependency list is read rather than reconstructed.
    const src = read(DRAFT_SRC);
    const at = src.indexOf("onDraftChange({ groups: [], blocking: null })");
    expect(at, "the collector's mount report must be findable").toBeGreaterThan(-1);
    const deps = /\}, (\[[^\]]*\])\);/.exec(src.slice(at));
    expect(deps, "the effect's dependency list must be findable").not.toBeNull();
    expect(deps![1], "a non-empty dependency list clears live typing").toBe("[]");
  });

  it("the PANEL remounts the collector on any identity change", () => {
    // All four parts, because each one changes what the same numbers mean.
    const src = read(PANEL_SRC);
    const arm = src.slice(src.indexOf("!blockId && onSettingDraft && mode ?"));
    expect(arm).toMatch(/key=\{`\$\{chosen\.device\.deviceId\}::\$\{chosen\.profile\.profileId\}::\$\{chosen\.profile\.version\}::\$\{mode\.key\}`\}/);
  });

  it("the PANEL clears the host's draft when NO collector renders", () => {
    // The second shape: she clears the machine, the collector vanishes, and
    // the host would otherwise keep the draft it last heard about.
    const src = read(PANEL_SRC);
    expect(src).toMatch(/!blockId && onSettingDraft && !\(chosen && mode\) && \(/);
    expect(src).toMatch(/<MachineSettingDraftReset onSettingDraft=\{onSettingDraft\} \/>/);
  });

  it("the ENTRY form's next capture keeps the prior group identities", () => {
    // THE DEFECT (Codex, #860 4290452715). "Record a setting change" reset to
    // `firstGroup()`, so after a save of g1 AND g2 the form offered one fresh
    // g1 - and a change to what had been g2 was submitted as a revision of g1.
    // Guidance returns the newest capture PER GROUP KEY, so it then combined
    // the repurposed g1 with the stale g2.
    //
    // PINNED ON SOURCE because it is an onClick handler, which this repo has
    // no jsdom to exercise; the behaviour itself is proved by the pure
    // function's tests and MOUNTED in the multi-group revision journey.
    // THE MECHANISM CHANGED AND THE PROPERTY DID NOT (Codex, #860
    // 4307523224). Carrying the draft's own groups forward kept their
    // `recorded` flag, so in a previously EMPTY scope every group still
    // claimed to be NEW after the first save - and the next change was issued
    // ANOTHER key at revision 1 instead of revising. The identity survived the
    // reset and then never settled, which guidance renders the same way: two
    // separate probes.
    //
    // So the next capture re-seeds from the RECORD. That keeps this test's
    // original claim - after a save of g1 and g2 the form still offers two
    // groups - and strengthens it, because the keys are now the ones the
    // database issued rather than the ones this mount invented.
    // THROUGH `reseedFromRecord` NOW, not inline (Codex, #860 4307735441 and
    // 4307735445). The draft is one of THREE values derived from the recorded
    // set, and setting it alone left the ordinal and the staleness baseline at
    // their mount values. The property this test states is unchanged; the
    // single function is what keeps its two siblings honest.
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/reseedFromRecord\(\);/);
    expect(src).toMatch(/const reseedFromRecord = \(\) => \{/);
    expect(
      src,
      "resetting to firstGroup() is what renumbered her groups",
    ).not.toMatch(/setGroups\(firstGroup\(\)\)/);
    expect(
      src,
      "carrying the draft forward preserves `recorded: false` on a saved group",
    ).not.toMatch(/setGroups\(clearedForNextCapture\)/);
  });

  it("the ENTRY form SEEDS its draft from what is already recorded", () => {
    // THE ROUND-5 DEFECT (Codex, #860 4294673722), and the fourth way into
    // one invariant: a group identity must survive every way this form can be
    // mounted. Round 4 closed the within-mount path with
    // `clearedForNextCapture`; a RELOAD has no mount-local state to preserve,
    // so its initializer must take the identities from the RECORD.
    //
    // Both halves are asserted. A seed that is not scoped is the same defect
    // pointed the other way - it would import another unit's probe layout.
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/useState<SettingGroupDraft\[\]>\(\(\) =>\s*groupsFromRecorded\(/);
    expect(src).toMatch(/groupsFromRecorded\(recordedGroups, \{/);
    expect(
      src,
      "a bare firstGroup initializer is the reload defect",
    ).not.toMatch(/useState<SettingGroupDraft\[\]>\(firstGroup\)/);
  });

  it("the entry form's ordinal STARTS from that seed", () => {
    // A restored draft begins with identities this mount did not issue, so a
    // counter starting at a flat 1 beside a seeded g1 and g2 mints a second
    // g2 on the next add - the corruption the seed exists to prevent,
    // arriving through the repair.
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/useState\(\(\) => highestOrdinal\(groups\)\)/);
    expect(src).not.toMatch(/const \[groupOrdinal, setGroupOrdinal\] = useState\(1\)/);
  });

  it("the PANEL actually forwards the recorded groups to it", () => {
    // The forwarding half, which is where this family of defects keeps
    // landing: the loader, the props and the panel were all correct three
    // times while the feature was inert in the route because one line was
    // missing (Codex, 2351742d, 15cc6c99, #860 4290452722). A seed wired to
    // nothing is a fresh g1 by another name.
    const src = read(PANEL_SRC);
    expect(src).toMatch(/recordedGroups=\{recordedSetup\}/);
  });

  it("the ENTRY form freezes the draft while a save is unresolved", () => {
    // THE INVARIANT (Codex, #860 4296029605): while a save's outcome is
    // unknown, its payload is frozen. `canEditDraft` encoded this rule from
    // the day the state machine was written and was wired to NOTHING, so the
    // controls stayed live through an unresolved save.
    //
    // What that cost: the retry key is preserved so pressing Save again is
    // safe, but the command binds that key to a digest of the payload.
    // Editing first makes the retry a DIFFERENT payload under the same key,
    // so a first attempt that committed refuses it as a mismatch — and
    // editing again mints a new key, appending a second capture of settings
    // entered once.
    const src = read(ENTRY_SRC);
    // PINNED ON THE PROPERTY, NOT THE CALL SHAPE. The previous version of
    // this guard matched `!canEditDraft(save)` literally, so it described the
    // exact expression that was MISSING the in-flight argument and would have
    // gone red on the fix while staying green on the defect
    // (Codex, #860 4305022472). What matters is that the freeze is computed
    // from the save state AND the request's own duration, and that the
    // reading grid receives it.
    expect(src).toMatch(/const frozen = !canEditDraft\(\s*save\s*,\s*pending\s*\)/);
    expect(src).toMatch(/frozen=\{frozen\}/);
  });

  it("and what it reports to the PANEL is the TRANSPORT hold, not the whole freeze", () => {
    // TWO DEFECTS, ONE LINE, IN OPPOSITE DIRECTIONS. Reporting only the
    // settled `save.unresolved` left the host's controls live through the
    // request itself (4305022472); reporting the whole `frozen` left them
    // DEAD after an acknowledged save, because `frozen` also covers
    // `recorded` (4305364945). The host freezes those controls for exactly
    // one reason — each can discard this save's retry key — so what it needs
    // is the window in which a key is at risk, and nothing wider.
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/onUnresolvedChange\?\.\(transportHold\)/);
    expect(src).not.toMatch(/onUnresolvedChange\?\.\(frozen\)/);
    expect(src).not.toMatch(/onUnresolvedChange\?\.\(save\.unresolved\)/);
    // And the hold itself must not consult the acknowledged state.
    const hold = assignedExpression(src, "transportHold");
    expect(hold, "an acknowledged save still holds the host's controls").not.toMatch(
      /recorded|canEditDraft/,
    );
  });

  it("while the ENTRY's own fields stay frozen after an acknowledged save", () => {
    // The other half, and it is not symmetrical: after a recorded save she
    // starts a new capture rather than editing the one in the record, so
    // `frozen` keeps `recorded` while the reported hold does not.
    const src = read(ENTRY_SRC);
    expect(assignedExpression(src, "frozen")).toMatch(/canEditDraft\(/);
  });

  it("and refuses the edit at the HANDLER, not only at the controls", () => {
    // Belt and braces, because the failure mode is a duplicate clinical
    // capture: a control added later without the `frozen` wiring still
    // cannot move the payload.
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/const editDraft = [^;]*\{\s*(\/\/[^\n]*\n\s*)*if \(frozen\) return;/);
  });

  it("every draft control in the shared fields takes the freeze", () => {
    // Enumerated rather than spot-checked: these four are the complete set of
    // controls that feed either digest, and the count is what makes "all of
    // them" checkable rather than asserted.
    const src = read(FIELDS_SRC);
    const disabled = src.match(/disabled=\{frozen\}/g) ?? [];
    expect(
      disabled.length,
      "a draft control was added without the freeze",
    ).toBeGreaterThanOrEqual(3);
    // The add-group button composes it with its own condition.
    expect(src).toMatch(/disabled=\{frozen\}[\s\S]{0,80}data-testid="setting-group-add"/);
    // And the reason is on screen, so a dead form is not a broken one.
    expect(src).toMatch(/data-testid="setting-draft-frozen"/);
  });

  it("the CREATE-MODE collector refuses the edit at its own handler", () => {
    // FOUND BY THE MOUNTED PROOF, not by review. The host froze its draft and
    // these controls rendered disabled, so the screen was correct — but this
    // collector keeps its OWN groups state and reports upward, and that path
    // had no guard. Driving React's change event past a disabled input still
    // moved the draft, the host carried the edited value into the retry under
    // the held key, and the command refused it as a payload mismatch: the
    // defect of #860 4296029608 reproduced by the test written to prove it
    // fixed.
    const src = read(DRAFT_SRC);
    expect(src).toMatch(/const editDraft = [^;]*\{\s*(\/\/[^\n]*\n\s*)*if \(frozen\) return;/);
  });

  it("the INITIAL save freezes its payload at the setter", () => {
    // THE SAME INVARIANT on the other save path (Codex, #860 4296029608).
    // `create_block_with_initial_setup` digests all 27 parameters, so any
    // field edited under a held key turns the promised safe retry into a
    // mismatch refusal and pushes toward cancel-and-recreate: a duplicate
    // area.
    //
    // FROZEN AT THE SETTER rather than control by control. This form has five
    // user-driven writers and more fields than any one of them touches, so a
    // per-control list goes stale the next time a field is added — and a
    // missed one is a duplicated clinical record.
    const src = read(FORM_SRC);
    // THE FREEZE COVERS BOTH WINDOWS (Codex, #860 4305022475): the request's
    // own duration AND the unresolved aftermath. Asserted on what the flag is
    // derived from, not on how the expression is written — the previous
    // version of this guard matched `const draftFrozen = saveUnresolved`
    // literally, which is precisely the spelling that omitted the in-flight
    // window.
    const frozenExpr = assignedExpression(src, "draftFrozen");
    expect(
      frozenExpr,
      "the freeze does not cover the request's own duration",
    ).toContain("pending");
    expect(
      frozenExpr,
      "the freeze does not cover the unresolved aftermath",
    ).toContain("saveUnresolved");
    expect(src).toMatch(
      /const setDraft: typeof setDraftRaw = \(\.\.\.args\) => \{\s*if \(draftFrozen\) return;/,
    );
    // Nothing may reach the raw setter except the shadow itself.
    const rawUses = (src.match(/setDraftRaw\(/g) ?? []).length;
    expect(rawUses, "something bypasses the frozen setter").toBe(1);
  });

  it("and the machine settings freeze with it, being the same payload", () => {
    // In create mode the panel's draft travels in THIS form's save, so the
    // digest covers it too. One flag, not a second rule that could disagree.
    const src = read(FORM_SRC);
    expect(src).toMatch(/settingDraftFrozen=\{draftFrozen\}/);
    expect(src).toMatch(/disabled=\{pending \|\| draftFrozen\}/);
    const panel = read(PANEL_SRC);
    expect(panel).toMatch(/frozen=\{settingDraftFrozen\}/);
    const conn = read(CONN_SRC);
    expect(conn).toMatch(/settingDraftFrozen=\{settingDraftFrozen\}/);
  });

  it("a stale selection write cannot overwrite a newer pick", () => {
    // THE DEFECT (Codex, #860 4296709037). Two picks in quick succession
    // overlap and the server answers in whatever order it finishes. Every
    // completion was applied, so an earlier request finishing LAST restored
    // the older device as both selected and persisted — the panel and the
    // stored selection then both disagreed with what she last chose.
    //
    // ONE counter shared by the device and mode handlers, deliberately: both
    // write the same stored selection, so a stale mode completion must not
    // land after a newer device pick either. Two counters would allow it.
    const src = read(PANEL_SRC);
    expect(src).toMatch(/const selectionRequestRef = useRef\(0\)/);
    const tokens = src.match(/const token = \+\+selectionRequestRef\.current;/g) ?? [];
    expect(tokens.length, "both selection writers must take a token").toBe(2);
    const guards = src.match(/if \(token !== selectionRequestRef\.current\) return;/g) ?? [];
    expect(guards.length, "both writers must drop a stale completion").toBe(2);
  });

  it("a post-commit read failure is reported as UNRESOLVED, not as a failure", () => {
    // THE DEFECT (Codex, #860 4296709051). The command commits, the
    // read-back fails, and a plain {ok:false} told the form the save had
    // FAILED — so it neither froze the payload nor kept the retry key. An
    // edit-and-retry then meets the digest as a mismatch, and the way out of
    // a mismatch looks like cancel-and-recreate: a duplicate area.
    //
    // Only on the withSetup path, because only that command binds a retry
    // key; without one there is no safe retry to offer.
    // RE-POINTED AT THE DELEGATION (Codex, #860 4309128376). The outcome used
    // to be a ternary written out at each site; there are now THREE sites -
    // the missing block, this read-back, and a missing setup receipt - so it
    // is factored into `unresolvableResponse()`. The claim is the same and the
    // assertion is stronger: previously each branch could have carried a
    // subtly different ternary and this would still have passed.
    //
    // SCOPED TO THE BRANCH, not matched by proximity: a lazy gap reached past
    // the end of a branch once already in this file, and the fix was to bound
    // the slice to the thing it is about.
    const src = read(ACTIONS_SRC);
    const i = src.indexOf("if (blockReadErr || !blockRow)");
    expect(i, "the read-back failure branch is gone").toBeGreaterThan(-1);
    const j = src.indexOf("const block = blockRow as SessionBlock", i);
    expect(j, "the end of the branch is gone").toBeGreaterThan(i);
    expect(
      src.slice(i, j),
      "the post-commit read failure no longer reports the unresolved outcome",
    ).toMatch(/return unresolvableResponse\(\);/);
    // AND THE ONE DEFINITION still carries the withSetup rule and the fields
    // the form acts on.
    const helper = src.slice(
      src.indexOf("const unresolvableResponse"),
      src.indexOf("const createdBlockId"),
    );
    expect(helper, "the shared outcome is gone").toMatch(/withSetup/);
    expect(helper).toMatch(/unresolved: true as const,/);
    expect(helper).toMatch(/error: INITIAL_SAVE_UNRESOLVED,/);
  });

  it("and the form already freezes on exactly that signal", () => {
    // The action's new outcome is only worth anything if the host acts on
    // it. This is the same field the lost-response path sets, which is why
    // the two cases now behave identically — they are indistinguishable to
    // the practitioner and must be.
    const src = read(FORM_SRC);
    expect(src).toMatch(/if \("unresolved" in res && res\.unresolved\) setSaveUnresolved\(true\)/);
    expect(assignedExpression(src, "draftFrozen")).toContain("saveUnresolved");
  });

  it("the stale-group refusal REACHES the action, hop by hop", () => {
    // ASSERTED AT EVERY HOP, because this lane's most repeated defect is a
    // value that exists, is correct, and never arrives. The rule itself is
    // proved behaviourally in tests/lib/machines/stale-setting-groups.test.ts;
    // what this pins is that the action is given something to compare
    // (Codex, #860 4305780322).
    const entry = read(ENTRY_SRC);
    // 1/3 the entry captures the set AT DRAFT BUILD, not at submit — the
    // identity it will mint is a function of exactly that snapshot.
    expect(entry, "1/3 the entry does not capture the recorded set").toMatch(
      // IT HAS A SETTER NOW, because the re-seed has to move it too - a
      // baseline frozen at the mount made the next capture trip the very
      // refusal it was meant to satisfy (Codex, #860 4307735441).
      /const \[expectedGroupKeys, setExpectedGroupKeys\] = useState<string\[\]>\(\(\) =>/,
    );
    // 2/3 and sends it with the save.
    expect(entry, "2/3 the captured set never leaves the entry").toMatch(
      /idempotencyKey: key,\s*groups: submissions,\s*expectedGroupKeys,/,
    );

    // 3/3 the action compares it BEFORE the write, and the comparison IS the
    // guard's condition.
    //
    // PINNED WITH NO GAP, because the first spelling of this asserted only
    // that the call's TEXT appeared before the write — which a dead
    // `if (false && recordedGroupsMoved(...))` satisfies perfectly. The
    // negative control caught it. `read()` strips comment lines, so a
    // zero-gap match is reliable here and a `{0,N}` gap is not.
    const actions = read(SETUP_ACTIONS_SRC);
    expect(
      actions,
      "3/3 the comparison is not the condition that refuses",
    ).toMatch(
      /if \(recordedGroupsMoved\(input\.expectedGroupKeys, seen\)\) \{\s*return \{ ok: false, code: "rejected", error: SETUP_GROUPS_MOVED \};\s*\}/,
    );
    const i = actions.indexOf("recordedGroupsMoved(input.expectedGroupKeys");
    const j = actions.indexOf("const out = await recordSetupSubmission(db, {");
    expect(
      i,
      "3/3 the comparison happens AFTER the write, which is no guard at all",
    ).toBeLessThan(j);
  });

  it("and a FAILED read of the recorded groups refuses, rather than skipping the guard", () => {
    // The direction that matters: treating an unreadable set as "no change"
    // would disable the guard exactly when the database is unhappy, which is
    // when a concurrent save is most likely to be in flight.
    const actions = read(SETUP_ACTIONS_SRC);
    const i = actions.indexOf(
      'if (input.expectedGroupKeys && groups.some((g) => g.groupKey !== null)) {',
    );
    expect(i, "the staleness block is gone").toBeGreaterThan(-1);
    const block = actions.slice(i, actions.indexOf("const out = await recordSetupSubmission", i));
    // ZERO GAP, for the same reason as above: a `{0,400}` window reached the
    // NEXT refusal return eight lines down, so emptying this branch still
    // matched. Comment lines are already stripped by `read()`.
    expect(
      block,
      "an unreadable recorded set no longer refuses, so the guard is skipped exactly when it matters",
    ).toMatch(
      /if \(!current\.ok\) \{\s*return \{ ok: false, code: "rejected", error: SETUP_GROUPS_MOVED \};\s*\}/,
    );
  });

  it("and it only applies to a REVISE, because a new group cannot collide", () => {
    // ops01's ruling after the identity moved into the database. A save made
    // entirely of new groups is issued its own keys under a block-wide lock,
    // so a stale draft still lands as a distinct group - refusing it would
    // cost a reload for nothing. A revise from a moved snapshot is the case
    // that still means her baseline has shifted.
    const actions = read(SETUP_ACTIONS_SRC);
    expect(
      actions,
      "the staleness refusal applies to new groups too, which can no longer collide",
    ).toContain("groups.some((g) => g.groupKey !== null)");
  });

  it("and the claim is OPTIONAL, so an older caller is not silently blocked", () => {
    // The per-group action and other callers do not send the set. Absent must
    // mean "no claim" and skip the check, not "nothing was recorded" — which
    // would refuse every save those callers make.
    const actions = read(SETUP_ACTIONS_SRC);
    expect(actions).toMatch(/expectedGroupKeys\?: string\[\];/);
    expect(actions).toMatch(/if \(input\.expectedGroupKeys &&/);
  });

  it("a malformed CREATE success is unresolved, exactly like the read-back failure", () => {
    // THE DEFECT (Codex, #860 4305702528). `create_block_with_initial_setup`
    // returns no RPC error and no `block_id` — the stale-function or
    // unexpected-shape case the check exists for — so the command MAY already
    // have committed the area and its settings. Reporting a plain failure left
    // the form editable and dismissible, so an edit or a remount discarded the
    // held key and a later save created a DUPLICATE area.
    //
    // The sibling case above (4296709051) is a post-commit READ failure and
    // was already handled. This is the same fact arriving one line earlier,
    // and the two must agree.
    // SCOPED TO THE BRANCH ITSELF, because the first spelling of this guard
    // was MATCHED BY PROXIMITY: a lazy gap reached past the end of this branch
    // into the read-back block below, which also returns
    // `unresolved: true as const` - so the guard passed with this branch
    // reverted to a plain failure. The negative control caught it, and the
    // lesson is the recurring one: bound an extraction to the thing it is
    // about, never to a window that can leave it.
    const src = read(ACTIONS_SRC);
    const i = src.indexOf("if (!createdBlockId)");
    expect(i, "the malformed-success branch is gone").toBeGreaterThan(-1);
    const j = src.indexOf("const { data: blockRow", i);
    expect(j, "the read-back that bounds this branch is gone").toBeGreaterThan(i);
    const branch = src.slice(i, j);
    // THE DELEGATION, for the reason given on the read-back guard above: the
    // outcome is one definition now, shared by three sites.
    expect(
      branch,
      "a malformed create success is still reported as a definitive failure",
    ).toMatch(/return unresolvableResponse\(\);/);
  });

  it("a PRE-WRITE lineage refusal on the CREATE path is rejected, not unresolved", () => {
    // THE DEFECT (Codex, #860 4305702526), and the twin of the setup action's
    // below. The create form's catch labels anything thrown as unresolved
    // whenever settings are attached, so a stale session froze the draft, the
    // machine controls and Cancel — and every retry repeated the same error,
    // with nothing written and no way out.
    const src = read(ACTIONS_SRC);
    // Scoped to the create action, so the setup action's own catch cannot
    // satisfy this.
    const i = src.indexOf("export async function createTreatmentAreaWithEntryAction");
    expect(i, "the create action is gone").toBeGreaterThan(-1);
    const after = src.slice(i);
    const body = after.slice(0, after.indexOf("export async function", 1));
    expect(
      body,
      "the create action must catch the lineage refusal rather than let it reach the form's catch",
    ).toMatch(/catch \(cause\) \{[\s\S]{0,400}?cause instanceof SessionLineageError/);
    // Reported as a DEFINITE non-write: no `unresolved` on this result.
    const lineage = /cause instanceof SessionLineageError\) \{\s*return \{([\s\S]{0,400}?)\};/.exec(
      body,
    );
    expect(lineage, "the lineage refusal's result was not found").toBeTruthy();
    expect(lineage![1]).toContain("ok: false");
    expect(
      lineage![1],
      "a pre-write refusal was reported as possibly-committed",
    ).not.toContain("unresolved");

    // AND THE REDIRECT MUST STILL PROPAGATE. `getCurrentPractitionerWithStudio`
    // calls Next's `redirect()` for an anonymous session, which throws;
    // swallowing that to report a definitive failure would leave her on a dead
    // form instead of the login page.
    expect(
      body,
      "a non-lineage throw is swallowed, which would eat Next's redirect",
    ).toMatch(/throw cause;/);
  });

  it("a PRE-WRITE lineage refusal is rejected, not unresolved", () => {
    // THE P2 (Codex, #860 4304930968). `assertSessionForClient` throws
    // before anything is written, and the entry maps a throw to the
    // UNRESOLVED state — which keeps the retry key and freezes the draft,
    // the machine and mode pickers, and the host's Cancel button. Nothing
    // had been written, so there was nothing ambiguous to protect: she was
    // left with a form she could neither save nor dismiss, where every
    // retry repeated the same refusal and the state could never settle.
    //
    // A DEADLOCK CREATED BY ROUNDS 14 AND 20. Each control was frozen
    // correctly for a genuinely unresolved save; nothing distinguished that
    // from a refusal that merely arrived the same way.
    const src = read(SETUP_ACTIONS_SRC);
    expect(
      src,
      "the recorder must catch the lineage refusal rather than let it reach the entry's catch",
    ).toMatch(/catch \(e\) \{[\s\S]{0,400}?e instanceof SessionLineageError/);
    expect(
      src,
      "and report it as a definite non-write",
    ).toMatch(/e instanceof SessionLineageError[\s\S]{0,300}?code: "rejected"/);

    // CAUGHT BY TYPE, NOT BLANKET. Reporting a genuinely ambiguous write as
    // rejected unfreezes the draft and releases the key — the opposite
    // error, and the one that costs a duplicate clinical record.
    // ANCHORED ON THE CODE, not the comment beside it: `read()` replaces
    // every comment line with a space, so a regex pinned to prose can never
    // match. That is the third time tonight — it is a property of the
    // helper, not an accident.
    expect(
      src,
      "an unrecognised failure must keep its throw, so it still reaches the unknown path",
    ).toMatch(/catch \(e\) \{[\s\S]{0,700}?throw e;\s*\}/);
  });

  it("the owners of \"a save is unresolved\" are ENUMERATED, so a fourth is loud", () => {
    // WHY A CENSUS AND NOT A RULE. Four controls across four rounds have had
    // to be wired to this fact, and each time the wiring was correct for the
    // case in front of me and blind to its sibling (rounds 5, 12, 14, 20).
    // The structural fix is ONE value with ONE owner that every save path
    // writes and every dismiss/identity control reads — proposed for the
    // next round rather than done mid-review.
    //
    // Until then this makes a new flag impossible to add quietly: adding a
    // save path, or a second mirror of an existing one, fails here with the
    // list in front of you. It pins WHAT the owners are, not how many, and
    // it fails with the diff rather than a bare number.
    const OWNERS: Array<[string, string]> = [
      // The host form's own create-mode save.
      [FORM_SRC, "saveUnresolved"],
      // The panel's revision save, mirrored into the host so the host's
      // Cancel can read it. THIS MIRROR is the duplication the refactor
      // removes.
      [FORM_SRC, "revisionUnresolved"],
      [PANEL_SRC, "revisionUnresolved"],
    ];

    const found: string[] = [];
    for (const src of [FORM_SRC, PANEL_SRC, CONN_SRC, ENTRY_SRC]) {
      const text = read(src);
      for (const m of text.matchAll(
        /const \[(\w*[Uu]nresolved)\s*,\s*set\w+\]\s*=\s*useState/g,
      )) {
        found.push(`${src}:${m[1]}`);
      }
    }

    expect(
      found.sort(),
      "the set of components owning unresolved-save state changed. A new owner must be read by EVERY dismiss and identity control, or it is the round-20 defect again — and if the single-owner refactor has landed, this census should be deleted rather than extended",
    ).toEqual(OWNERS.map(([f, n]) => `${f}:${n}`).sort());

    // NON-VACUITY: a regex that matched nothing would make the comparison
    // above pass only when the expected list was also empty, but say so
    // clearly rather than leaving it to be inferred.
    expect(found.length, "no unresolved-state owners were found at all").toBe(3);
  });

  it("DISMISSAL freezes on a REVISION save too, not only the create save", () => {
    // THE P2 (Codex, #860 4302176844), and the FOURTH control to join this
    // one invariant: the draft setter (round 5), the machine and mode
    // pickers (round 12), the host's Cancel (round 14), and now Cancel
    // again — for the other kind of save.
    //
    // Round 14 wired Cancel to `saveUnresolved`, which is THIS form's
    // create-mode save. Round 12's `revisionUnresolved` lived inside the
    // panel and never left it. So on an EXISTING block, where the panel
    // records directly, Cancel stayed live through an unresolved revision
    // save — and unmounting the entry is what discards the retry key.
    const form = read(FORM_SRC);
    const cancel = form.match(
      /disabled=\{([^}]*)\}\s*\n\s*data-testid="cancel-treatment-area"/,
    );
    expect(
      cancel,
      "the Cancel button's disabled expression was not found — this guard would be blind",
    ).toBeTruthy();
    expect(
      cancel![1],
      "Cancel must observe the create-mode save",
    ).toMatch(/saveUnresolved/);
    expect(
      cancel![1],
      "Cancel must observe the panel's REVISION save as well, or one click discards the retry key on an existing block",
    ).toMatch(/revisionUnresolved/);

    // THEY STAY SEPARATE pieces of state, combined only at the control.
    // Different owners, either can be true alone, and merging them would
    // make clearing one clear the other.
    expect(form).toMatch(
      /const \[revisionUnresolved, setRevisionUnresolved\] = useState\(false\)/,
    );
  });

  it("and the panel's revision state REACHES the host, hop by hop", () => {
    // ASSERTED AT EVERY HOP, because this is the lane's most repeated
    // defect: a value that exists, is correct, and never arrives. Five
    // instances so far, and this value crosses FOUR components.
    const entry = read(ENTRY_SRC);
    // It reports the TRANSPORT hold, which covers the request's own duration
    // as well as an unknown outcome — the host's identity controls can
    // discard the retry key in both windows (Codex, #860 4305022472) — but
    // NOT an acknowledged save, which has no key left to protect
    // (4305364945).
    expect(entry, "1/4 the entry reports its transport hold").toMatch(
      /onUnresolvedChange\?\.\(transportHold\)/,
    );
    const hold = assignedExpression(entry, "transportHold");
    expect(hold, "1/4 the reported hold misses the in-flight window").toContain(
      "pending",
    );
    expect(hold, "1/4 the reported hold misses an unknown outcome").toContain(
      "save.unresolved",
    );

    const panel = read(PANEL_SRC);
    expect(panel, "2/4 the panel subscribes to the entry").toMatch(
      /onUnresolvedChange=\{setRevisionUnresolved\}/,
    );
    expect(
      panel,
      "2/4 the panel must report it upward, on both edges",
    ).toMatch(/onRevisionUnresolved\?\.\(revisionUnresolved\)/);

    const conn = read(CONN_SRC);
    expect(conn, "3/4 the connector forwards it").toMatch(
      /onRevisionUnresolved=\{onRevisionUnresolved\}/,
    );

    const form = read(FORM_SRC);
    expect(form, "4/4 the host subscribes to it").toMatch(
      /onRevisionUnresolved=\{setRevisionUnresolved\}/,
    );
  });

  it("EVERY relayed failure on the recorder path carries the outcome code", () => {
    // THE P2 (Codex, #860 4301771498), and the fifth time in this lane that
    // a value existed, was correct, and was never forwarded.
    //
    // Round 16 taught the query, the action and the entry to tell a
    // transport failure from a refusal, and I wrote a guard asserting those
    // three links by name. The connector between the action and the entry
    // returned only the error text, so `code: "unknown"` was produced
    // correctly, forwarded correctly, and discarded one hop short of the
    // component that acts on it.
    //
    // WHAT ACTUALLY FAILED WAS NOT THE LIST OF FILES — the connector was
    // already in it. It was asserting NAMED patterns inside each file
    // instead of every failure the file relays. So this checks them all.
    //
    // AND IT IS SCOPED TO THE RECORDER PATH, not to every wrapper: a
    // selection failure legitimately carries no code, because there is no
    // retry key to protect. Requiring one there would be ceremony, and
    // ceremony is what makes a guard get relaxed later.
    const relayedFailures = (text: string): string[] =>
      [...text.matchAll(/\{[^{}]*ok:\s*false[^{}]*\}/gs)]
        .map((m) => m[0])
        // Only failures RELAYING an upstream result. A guard clause that
        // refuses before the recorder is called has no code to carry.
        .filter((f) => /\bout\./.test(f));

    // THE RELAY IS A NAMED FUNCTION NOW, and that is the durable part of
    // this guard: the component must DELEGATE to it rather than hand-roll a
    // return, because a hand-rolled one is exactly where the last five
    // dropped values lived.
    const conn = read(CONN_SRC);
    expect(
      conn,
      "the connector must delegate the relay, not rebuild it inline",
    ).toMatch(/return relayRecordResult\(out\);/);

    // SLICED BETWEEN TWO STABLE MARKERS, not matched with a lazy `\n}`.
    // That spelling stopped at the end of the PARAMETER TYPE LITERAL rather
    // than the function body — the third time tonight an extraction anchor
    // has stopped early and failed for a reason unrelated to the claim.
    const relayStart = conn.indexOf("export function relayRecordResult");
    const relayEnd = conn.indexOf("export function MachineFirstSetupConnected");
    expect(
      relayStart >= 0 && relayEnd > relayStart,
      "relayRecordResult was not found above the component",
    ).toBe(true);
    const relay = [conn.slice(relayStart, relayEnd)];

    let checked = 0;
    for (const [what, text] of [
      ["the relay", relay![0]],
      ["the action", read(SETUP_ACTIONS_SRC)],
    ] as const) {
      for (const failure of relayedFailures(text)) {
        checked += 1;
        expect(
          failure.replace(/\s+/g, " "),
          `${what} relays a failure without its code — this is exactly where the unknown outcome was lost`,
        ).toMatch(/code/);
      }
    }
    // NON-VACUITY, and it has already earned its place twice: the first
    // version only matched `return { ... }` and so missed the connector's
    // TERNARY ARM — the precise construct the defect lived in — and the
    // second was scoped to a slice the relay then moved out of. Both times
    // this assertion is what said so.
    expect(
      checked,
      "fewer relayed failures were found than the recorder path has — the scan is missing a shape",
    ).toBeGreaterThan(1);
  });

  it("a TRANSPORT failure on the settings save is unknown, not refused", () => {
    // THE P2 (Codex, #860 4301722737). A dropped connection after the
    // command commits can arrive in PostgREST's `error` rather than as a
    // throw. The throw path was already handled; this is the same lost
    // response wearing the other shape, and it was being converted into an
    // ordinary refusal — which unfreezes the draft, releases the retry key,
    // and lets the next save append a duplicate immutable capture.
    //
    // THREE LINKS, ASSERTED SEPARATELY, because the classifier is worthless
    // if any one of them drops the distinction. That is not hypothetical:
    // four defects in this lane were a value that existed, was correct, and
    // was never forwarded.
    const q = read(QUERIES_SRC);
    expect(
      q,
      "the query must mark a non-definitive error as unresolved",
    ).toMatch(/unresolved: !isDefinitiveDatabaseAnswer\(error\)/);

    const actions = read(SETUP_ACTIONS_SRC);
    expect(
      actions,
      "the action must forward it rather than collapsing it to `rejected`",
    ).toMatch(/code: out\.unresolved \? "unknown" : "rejected"/);

    // THE MAPPING MOVED INTO `save-attempt` so a test could drive it, so
    // the claim here is in two halves: the rule lives there, and the entry
    // delegates to it instead of keeping a second copy.
    const save = read(SAVE_ATTEMPT_SRC);
    expect(
      save,
      "the unknown code must still reach the unknown outcome",
    ).toMatch(/if \(out\.code === "unknown"\) return \{ kind: "unknown" \};/);

    const entry = read(ENTRY_SRC);
    expect(
      entry,
      "the entry must delegate the mapping, not re-derive it",
    ).toMatch(/outcomeFromRecordResult\(out, submissions\.length\)/);
  });

  it("and so is a transport failure on the INITIAL save", () => {
    // The same rule one command over (Codex, #860 4301722740), and the same
    // unresolved result the post-commit READ failure already returns — the
    // two are indistinguishable to the practitioner and must behave alike.
    const src = read(ACTIONS_SRC);
    expect(src).toMatch(
      /if \(withSetup && !isDefinitiveDatabaseAnswer\(cmdErr\)\) \{/,
    );
    // WITHSETUP ONLY, and that condition is load-bearing rather than
    // defensive: `create_block_with_entry` binds no retry key, so there is
    // no safe retry to offer and freezing would strand her.
    expect(
      src,
      "the unresolved path must stay behind withSetup",
    ).toMatch(
      /if \(withSetup && !isDefinitiveDatabaseAnswer\(cmdErr\)\) \{[\s\S]{0,400}?unresolved: true as const/,
    );
  });

  it("the post-save refresh brings the UNIT NAMES with it", () => {
    // THE P2 (Codex, #860 4301669061). The refresh replaced `recordedSetup`
    // and left `unitNames` at its pre-save snapshot, so a capture saved
    // against a unit the loader had not already seen arrived with NO
    // physical machine against it until a reload. In a studio running two
    // units of one model that attribution is the entry's whole purpose, and
    // after switching units and saving again she has two unattributed
    // captures.
    const actions = read(SETUP_ACTIONS_SRC);
    expect(
      actions,
      "the refresh action must resolve names server-side — only the server can see a RETIRED unit",
    ).toMatch(/return \{ ok: true, readings: got\.value, unitNames \};/);
    expect(actions).toMatch(/await machinesByIds\(db, scope\.studioId, ids\)/);
    // A FAILED NAME LOOKUP IS NOT A FAILED READ: losing the history is far
    // worse than an unnamed unit.
    expect(
      actions,
      "a failed name lookup must not turn the whole read into a failure",
    ).toMatch(/if \(named\.ok\) for \(const m of named\.value\)/);
  });

  it("and MERGES them, because the refresh only re-reads this block", () => {
    // ASSERTED SEPARATELY AND ON PURPOSE. A plain assignment would satisfy
    // "the refresh updates unitNames" while introducing a second defect:
    // the loader's map also names the next-visit guidance and an unusable
    // stored selection, neither of which the refresh re-reads, so replacing
    // would name the new capture and silently UN-NAME the prior setup
    // beside it.
    const conn = read(CONN_SRC);
    expect(conn).toMatch(
      /unitNames: \{ \.\.\.prev\.unitNames, \.\.\.fresh\.unitNames \}/,
    );
    expect(
      conn,
      "a bare assignment would drop the names the refresh never re-reads",
    ).not.toMatch(/unitNames: fresh\.unitNames\b/);
  });

  it("DISMISSAL is frozen too, not just the payload", () => {
    // THE P2 (Codex, #860 4301633049). Cancel was `disabled={pending}`, so
    // the instant the lost response cleared `pending` it was live again —
    // and it is the one control that destroys the retry KEY rather than
    // changing the payload. `onCancel` closes the form, `saveUnresolved` and
    // `pendingSaveKey` go with it, and the next save mints a new key: if the
    // first attempt committed, that is a SECOND immutable treatment area for
    // one treatment.
    //
    // THIRD CONTROL, SAME INVARIANT: the draft setter (round 5), the machine
    // and mode pickers (round 12), and now the dismissal. Asserted as the
    // rule — the dismissal observes the unresolved flag — rather than as the
    // current expression, which is the mistake that made four of my earlier
    // guards fail on changes that strengthened them.
    const src = read(FORM_SRC);
    const cancel = src.match(
      /disabled=\{([^}]*)\}\s*\n\s*data-testid="cancel-treatment-area"/,
    );
    expect(
      cancel,
      "the Cancel button's disabled expression was not found — this guard would be blind",
    ).toBeTruthy();
    expect(
      cancel![1],
      "Cancel must observe the unresolved save, or one click discards the retry key",
    ).toMatch(/saveUnresolved/);

    // AND SAVE MUST NOT BE, or the freeze is a trap with no way out: pressing
    // Save again unchanged is the whole recovery.
    const save = src.match(
      /onClick=\{submit\}\s*\n\s*disabled=\{([^}]*)\}/,
    );
    expect(save, "the Save button's disabled expression was not found").toBeTruthy();
    // ASSERTED AS THE RULE: Save observes NO unresolved or frozen state at
    // all, whatever it is called. The first spelling named two flags —
    // `saveUnresolved|draftFrozen` — and round 20 added a third, so
    // freezing Save on `revisionUnresolved` slipped past a guard written
    // for exactly that trap. Pressing Save again, unchanged, is the whole
    // recovery; a freeze that includes it strands her with no way out.
    expect(
      save![1],
      "Save must stay live through every unresolved state — it is the recovery",
    ).not.toMatch(/[Uu]nresolved|[Ff]rozen/);
  });

  it("previous-treatment units go through the sentinel rule", () => {
    // THE DEFECT (Codex, #860 4296709059). `device-display` and `none` are
    // not units. Rendering them literally put "1.25 device-display" in
    // PREVIOUS TREATMENT while the recorded-history surface beside it showed
    // the same reading as plain "1.25" — the same defect repaired there in
    // 4288424526 and missed here.
    const src = read(PRIOR_SRC);
    expect(src).toMatch(/recordedUnitLabel\(r\.nativeUnit\)/);
    expect(
      src,
      "a bare nativeUnit render is how the sentinel leaked onto the screen",
    ).not.toMatch(/\{r\.nativeUnit\}\s*\n/);
  });

  it("the setup WRITE actions are bound to the authorized route", () => {
    // THE P1 (Codex, #860 4297032712). These actions had no client or
    // session context, so they could not apply the `assertSessionForClient`
    // lineage check the other charting actions use, and `assert_setup_scope`
    // derived only the block's studio. A practitioner is a member of the
    // WHOLE studio, so a stale page or a tampered request carrying another
    // client's block id appended IMMUTABLE readings to the wrong client's
    // treatment.
    // ASSERTED PER FUNCTION, not as a count over the file. The count version
    // of this did not fail when one action's check was deleted: three
    // remained and the threshold was three. A guard that cannot tell WHICH
    // action lost its check is not guarding the actions, it is counting
    // lines.
    const src = read(SETUP_ACTIONS_SRC);
    const bodyOf = (name: string) => {
      const at = src.indexOf(`export async function ${name}(`);
      expect(at, `${name} is not in the actions file`).toBeGreaterThan(-1);
      const next = src.indexOf("\nexport async function ", at + 1);
      return src.slice(at, next === -1 ? undefined : next);
    };
    for (const fn of [
      "recordReadingsAction",
      "recordSetupSubmissionAction",
      "readingsForBlockAction",
    ]) {
      expect(
        bodyOf(fn),
        `${fn} takes a block id and must authorize the route`,
      ).toMatch(
        /await assertSessionForClient\(scope\.studioId, input\.clientId, input\.sessionId\)/,
      );
    }
  });

  it("and the READ is bound too, which the finding did not name", () => {
    // `readingsForBlockAction` took a bare block id. The member-scoped
    // SELECT policy admits any block in the studio, so another client's
    // recorded settings were readable by id — the same hole pointed at a
    // different verb. Fixed here rather than left for a later round.
    const src = read(SETUP_ACTIONS_SRC);
    expect(src).toMatch(
      /export async function readingsForBlockAction\(input: \{[\s\S]{0,160}?clientId: string;[\s\S]{0,80}?sessionId: string;/,
    );
    expect(src).not.toMatch(
      /export async function readingsForBlockAction\(\s*blockId: string,\s*\)/,
    );
    // Taking the ids is not checking them; the per-function assertion above
    // is what proves the check runs on this path too.
  });

  it("the panel supplies the route, and the collector does not", () => {
    // The panel knows which block it is charting; it does not get to say
    // whose chart that is. The ids come from the page's props.
    const conn = read(CONN_SRC);
    expect(conn).toMatch(/recordSetupSubmissionAction\(\{\s*\.\.\.input,\s*clientId,\s*sessionId,\s*\}\)/);
  });

  it("selection writes are SERIALISED, not just de-duplicated on return", () => {
    // THE SECOND ROUND ON ONE DEFECT (Codex, #860 4296709037 then
    // 4297032722). The request token discards a stale ANSWER, but it runs
    // after the write has already committed — so the older value still won
    // in the database and came back on reload. Overlapping writes cannot be
    // ordered from the client, so they are not allowed to overlap.
    const src = read(PANEL_SRC);
    expect(src).toMatch(/const \[selectionPending, setSelectionPending\] = useState\(false\)/);
    const sets = src.match(/setSelectionPending\(true\)/g) ?? [];
    expect(sets.length, "both writers must take the lock").toBe(2);
    const clears = src.match(/setSelectionPending\(false\)/g) ?? [];
    expect(clears.length, "both writers must release it").toBe(2);
    // RELEASED IN `finally`, or one failed write kills the picker for the
    // rest of the treatment.
    expect((src.match(/\} finally \{\s*(\/\/[^\n]*\n\s*)*setSelectionPending\(false\);/g) ?? []).length).toBe(2);
    // AND BOTH CONTROLS OBSERVE IT: a mode change and a device change write
    // the same stored selection.
    // BOTH CONTROLS OBSERVE THE PENDING FLAG — asserted as a substring of
    // the condition rather than the whole of it, because round 10 added
    // `|| settingDraftFrozen` to both and an exact-match assertion would
    // fail on a change that STRENGTHENS the rule it is guarding.
    expect(src).toMatch(/disabled=\{[\s\S]{0,80}?selectionPending/);
    expect(
      (src.match(/selectionPending \|\| identityFrozen|selectionPending \|\| /g) ?? [])
        .length,
      "both the picker and the mode buttons must observe it",
    ).toBeGreaterThanOrEqual(2);
  });

  it("the recorded-reading READ binds the block to the session in a query", () => {
    // THE P1, AND IT IS MY OWN ROUND-8 REPAIR REPEATED (Codex, #860
    // 4298457378). That round added `assertSessionForClient` to the read
    // action and I reported the hole closed. It was not: the check
    // authorizes the ROUTE — that this session really is this client's —
    // and says nothing about the BLOCK. The query still filtered on an
    // unbound block id and the studio-member policy admitted it, so a
    // crafted request returned another client's captures and the chart
    // rendered them under "Recorded this treatment".
    //
    // An application lineage check authorizes the route. Only a predicate
    // in a query binds the record to it.
    const src = read(QUERIES_SRC);
    expect(src).toMatch(
      /export async function readingsForBlock\([\s\S]{0,2600}?sessionId: string,\s*\n\):/,
    );
    expect(src).toMatch(
      // THE BINDING MOVED INTO THE FUNCTION (Codex, #860 4305555264). It was
      // a bounded `.from("session_blocks").eq(id).eq(session_id)` lookup here,
      // followed by a read filtered on the block alone - sound only because
      // `session_blocks.session_id` is immutable, which is a property of a
      // trigger in another file. `setup_readings_for_block` JOINS the session,
      // so the binding is a predicate on the read itself and the session id
      // has to reach it.
      /db\.rpc\("setup_readings_for_block", \{\s*p_block_id: blockId,\s*p_session_id: sessionId,\s*\}\)/,
    );
  });

  it("every read call site passes the authorized session with the block", () => {
    // ENUMERATED, not spot-checked. The finding named one action; the sweep
    // of every action taking a block id found a second — the panel's own
    // load path, which runs on every open and needs no crafted save at all.
    const src = read(SETUP_ACTIONS_SRC);
    const calls = src.match(/readingsForBlock\(db, [^)]*\)/g) ?? [];
    expect(calls.length, "no reads found — the guard is looking at nothing").toBeGreaterThan(1);
    for (const call of calls) {
      expect(call, "a block id travelled without its session").toMatch(
        /readingsForBlock\(db, input\.blockId, input\.sessionId\)/,
      );
    }
  });

  it("the synthetic-profile gate parses the hostname instead of searching it", () => {
    // `/127\.0\.0\.1|localhost/.test(url)` is satisfied by
    // https://localhost.example.com and https://localhost@db.example.com,
    // which resolve elsewhere — so on a self-hosted deployment the fixture
    // flag enabled synthetic profiles against real data
    // (Codex, #860 4298457391).
    const src = read(SYNTH_SRC);
    expect(src).toMatch(/return isLoopbackUrl\(url\)/);
    expect(
      src,
      "a substring test is how the hostname check was bypassed",
    ).not.toMatch(/\/127\\\.0\\\.0\\\.1\|localhost\/\.test/);
  });

  it("and reuses the one loopback guard rather than a second spelling", () => {
    // Two spellings of "is this local" is how one of them ends up wrong.
    // The implementation lives in lib so production code can import it;
    // the e2e helper re-exports it.
    const env = read(LOCAL_ENV_SRC);
    // A RELATIVE path, not the `@/` alias: `vitest.db.config.ts` imports
    // this module at CONFIG LOAD to run #879's paired-target guard, and Node
    // resolves that before any vite alias exists — the alias took the whole
    // DB suite down with "Cannot find module" before a test ran.
    expect(env).toMatch(/export \{ isLoopbackUrl \} from "\.\.\/\.\.\/lib\/net\/loopback"/);
    expect(
      env,
      "local-env must not carry its own copy any more",
    ).not.toMatch(/export function isLoopbackUrl/);
  });

  it("the machine and mode controls freeze with the host's unresolved save", () => {
    // Round 6 froze the reading collector and I reported the invariant
    // closed; `settingDraftFrozen` was never applied to the IDENTITY
    // controls (Codex, #860 4299408376). Clearing the machine under a held
    // retry key sends the save down the non-setup path and duplicates the
    // area; switching changes the payload and the digest refuses the retry.
    // The machine and the mode are PART of what the key is bound to.
    // ASSERTED AS THE RULE, not the expression. Round 12 replaced
    // `settingDraftFrozen` at these call sites with `identityFrozen`,
    // which is settingDraftFrozen OR an unresolved REVISION save — a
    // strictly stronger freeze (Codex, #860 4300759930). An exact-text
    // assertion fails on a change that widens the rule it guards, which is
    // the fourth time that has happened in this lane.
    const src = read(PANEL_SRC);
    expect(
      src,
      "the freeze must come from EITHER save path",
    ).toMatch(/const identityFrozen = settingDraftFrozen \|\| revisionUnresolved/);
    expect(src).toMatch(/selectable\.length === 0 \|\| selectionPending \|\| identityFrozen/);
    expect(src).toMatch(/disabled=\{selectionPending \|\| identityFrozen\}/);
  });

  it("a rejected selection write is SETTLED as a failure, not dropped", () => {
    // `finally` cleared the pending flag but a throw skipped
    // `selectionSettled`, so the optimistic choice stayed on screen with no
    // failure note while the database kept the previous default — and a
    // reload silently restored the old machine (Codex, #860 4299408386).
    const src = read(PANEL_SRC);
    const catches = src.match(/\} catch \(cause\) \{[\s\S]{0,900}?write = \{\s*ok: false,/g) ?? [];
    expect(
      catches.length,
      "both selection writers must settle a rejection as a failed write",
    ).toBe(2);
  });

  it("the contract keeps requiredness, and the command enforces it", () => {
    // The published contract did not retain the profile's `optional` flag,
    // so the command validated only the readings it was GIVEN: a forged
    // call naming one of several required fields committed an incomplete
    // capture that guidance then presented as complete
    // (Codex, #860 4299434251).
    const sql = read(MIGRATION_SRC);
    expect(sql).toMatch(/optional boolean not null default false/);
    expect(sql).toMatch(/coalesce\(\(v_item->>'optional'\)::boolean, false\)/);
    expect(sql).toMatch(/and not f\.optional/);
    expect(sql).toMatch(/This capture is missing a required field for mode/);
  });

  it("the revision sequence is scoped to the whole setup identity", () => {
    // Keyed on block + group alone, a machine or mode switch continued the
    // previous unit's sequence and the history rendered Room 2's first
    // capture as "capture 2" (Codex, #860 4299434260).
    const sql = read(MIGRATION_SRC);
    expect(sql).toMatch(
      /select coalesce\(max\(c\.revision\), 0\) \+ 1[\s\S]{0,400}?and c\.studio_machine_id = p_studio_machine_id[\s\S]{0,200}?and c\.mode_key = v_mode;/,
    );
    // AND THE CONSTRAINT AGREES WITH THE ALLOCATION. Scoping one without
    // the other made Room 2's revision 1 collide with Room 1's — the DB
    // run caught a half-finished change that read as complete.
    expect(sql).toMatch(
      /constraint treatment_setup_captures_revision_uniq\s*\n\s*unique \(\s*\n\s*session_block_id, studio_machine_id, machine_profile_id,/,
    );
  });

  it("what is recorded is RE-READ after a save, so the seed is never stale", () => {
    // THE P1 (Codex, #860 4300386011), and the fifth way into one
    // invariant: a group identity must survive every remount.
    //
    // The entry form seeds its identities from `recordedSetup`, which was
    // loaded once when the panel opened and never refreshed. Save g1 and
    // g2, switch machine or mode, switch back — the remount seeds from a
    // snapshot that predates those captures, finds nothing, falls back to a
    // fresh g1, and a change meant for g2 lands as a g1 revision.
    //
    // THE SAME STALENESS ALSO HID THE CAPTURE FROM THE LIST BELOW, which
    // exists to stop her recording it twice. One root, two harms, one fix.
    const src = read(CONN_SRC);
    expect(src).toMatch(
      /if \(out\.ok\) \{[\s\S]{0,2200}?await mod\.readingsForBlockAction\(\{[\s\S]{0,200}?blockId: input\.blockId,/,
    );
    // ON SUCCESS the new readings replace the snapshot and the surface is
    // marked available again.
    expect(src).toMatch(/recordedSetup: fresh\.readings,[\s\S]{0,80}?recordedSetupUnavailable: false,/);
  });

  it("and a failed refresh does not fail the save that already committed", () => {
    // Reporting a committed save as failed is the lost-response defect,
    // manufactured. The refresh is best-effort; the next open reads truth.
    // AND ON FAILURE the PREVIOUS readings are kept and the surface is
    // marked unavailable — not replaced with an empty list.
    //
    // The first version of this guard asserted only that a `catch` existed.
    // It did, and it could never fire: the action returned `[]` rather than
    // throwing, so a transient failure installed an empty history and the
    // guard reported the protection as present (Codex, #860 4300759932).
    // Asserting the FAILURE BRANCH is what the claim actually needs.
    const src = read(CONN_SRC);
    expect(src).toMatch(/: \{ \.\.\.prev, recordedSetupUnavailable: true \}/);
    expect(
      src,
      "a thrown refresh must also become a failure, not an exception",
    ).toMatch(/\} catch \{\s*fresh = \{ ok: false \};/);
  });

  it("an UNAVAILABLE identity read refuses to drive a write at all", () => {
    // THE DEFECT (Codex, #860 4307523228). When the block-history read failed,
    // `recordedSetupUnavailable` changed only the warning renderer while the
    // entry still received `recordedSetup` as an EMPTY array - so it seeded a
    // fresh unrecorded group and stayed saveable. A mid-treatment change then
    // asked the database for a NEW key rather than revising the group whose
    // identity could not be loaded, and guidance kept both the stale and the
    // changed setting as separate probes.
    //
    // MY CHANGE MADE THIS WORSE, which is why it is fixed here rather than
    // carried. While the client named groups, an empty snapshot produced `g1`
    // and a save would have landed on the existing g1. Now an empty snapshot
    // means "ask for a new key", so the collision became a certainty instead
    // of a possibility.
    //
    // FAIL CLOSED: no identities, no recording. The warning still renders -
    // she is told why - and the history below is unaffected.
    const panel = read(PANEL_SRC);
    expect(panel).toMatch(
      /blockId && recordAndCount && mode && !recordedSetupUnavailable \?/,
    );
  });

  it("the re-seed moves ALL THREE derived values, not just the groups", () => {
    // TWO DEFECTS, ONE CAUSE (Codex, #860 4307735441 and 4307735445). The
    // draft, the monotonic ordinal and the staleness baseline are all
    // functions of the recorded set - the docblock on the baseline says so
    // outright, "the same moment `groupOrdinal` is seeded from them, because
    // the two are the same fact". Re-seeding the next capture moved ONE of the
    // three and left the other two at their MOUNT values:
    //
    //   * the baseline stayed `[]` from the empty-scope mount, so the next
    //     capture sent an EXISTING key with an empty expected set and tripped
    //     the staleness refusal it was meant to satisfy;
    //   * the ordinal stayed at 1 beside a re-seeded `g2`, so "Add setting
    //     group" minted a SECOND `g2` - duplicate React keys, and the
    //     collapsed revision history this whole path exists to prevent.
    //
    // SO IT IS ONE FUNCTION. Three setters at a call site is the shape that
    // produced this; `reseedFromRecord` is the shape that cannot.
    const entry = read(ENTRY_SRC);
    expect(entry).toMatch(/const reseedFromRecord = \(\) => \{/);
    const at = entry.indexOf("const reseedFromRecord = () => {");
    const body = entry.slice(at, entry.indexOf("\n  };", at));
    expect(body, "the re-seed does not set the draft").toMatch(
      /setGroups\(seeded\)/,
    );
    expect(body, "the re-seed leaves the ordinal behind").toMatch(
      /setGroupOrdinal\(/,
    );
    expect(body, "the re-seed leaves the staleness baseline behind").toMatch(
      /setExpectedGroupKeys\(/,
    );
    // THE ORDINAL NEVER GOES BACKWARDS: it is monotonic for the life of the
    // mount, so a removed group's identity is never reissued.
    expect(body).toMatch(/Math\.max\(prev, highestOrdinal\(seeded\)\)/);
    // AND THE CALL SITE DEFERS to it rather than re-deriving.
    expect(entry).toMatch(/reseedFromRecord\(\);/);
    expect(
      entry,
      "the next capture sets the draft directly again, so the siblings can drift",
    ).not.toMatch(/setGroups\(\s*groupsFromRecorded/);
  });

  it("and the recorded key set is projected ONCE, not spelled twice", () => {
    // Two spellings of "the set this draft was built from" is how a staleness
    // comparison comes to be made against the wrong baseline.
    const entry = read(ENTRY_SRC);
    expect(entry).toMatch(/function recordedKeysOf\(/);
    const uses = entry.match(/recordedKeysOf\(recordedGroups\)/g) ?? [];
    expect(
      uses.length,
      "the mount and the re-seed must share one projection",
    ).toBe(2);
  });

  it("the SEED SOURCES are enumerated, and every one is current", () => {
    // ops01 asked for this path to join the enumeration. The draft's
    // identities can come from exactly two places, and both must be
    // current at the moment they are read:
    //
    // THERE IS NOW EXACTLY ONE SOURCE, which is the simplification the
    // identity change bought (Codex, #860 4307523224). It used to be two:
    //
    //   1. WITHIN a mount, from the previous capture - `clearedForNextCapture`;
    //   2. ACROSS a mount, from the record - `groupsFromRecorded`.
    //
    // Source 1 is GONE, and its helper with it. Once the database issues the
    // keys, a draft carried forward from the previous capture holds
    // PLACEHOLDERS, not identities - so after the first save in an empty scope
    // every group still claimed to be new and the next change was issued
    // another key. The record is the only thing that knows what a group is
    // called, so it is the only legitimate seed.
    //
    // Both the mount and the next capture therefore read the SAME source, and
    // it is only as good as `recordedSetup` - which is why the awaited refresh
    // above is part of the invariant rather than a nicety, and why the panel
    // refuses to render this form at all when that read failed.
    const entry = read(ENTRY_SRC);
    const fromRecord = entry.match(/groupsFromRecorded\(recordedGroups, \{/g) ?? [];
    expect(
      fromRecord.length,
      "the mount and the next capture must seed from the same place",
    ).toBe(2);
    expect(
      entry,
      "the retired within-mount source is back, carrying placeholders forward",
    ).not.toMatch(/clearedForNextCapture/);
    // No THIRD source may appear without this guard being updated: a seed
    // that came from anywhere else would not be covered by either rule.
    const seeds = entry.match(/useState<SettingGroupDraft\[\]>\(/g) ?? [];
    expect(seeds.length, "the draft has exactly one initializer").toBe(1);
  });

  it("contract equality includes requiredness", () => {
    // I added `optional` to the contract and its enforcement last round and
    // left BOTH symmetric-difference projections without it, so
    // republishing a version with only optionality flipped was accepted as
    // an idempotent no-op and the stored requiredness silently diverged
    // from the catalogue (Codex, #860 4300386015).
    const sql = read(MIGRATION_SRC);
    expect(
      (sql.match(/coalesce\(\(f->>'optional'\)::boolean, false\) as optional/g) ?? [])
        .length,
      "both incoming projections must carry optional",
    ).toBe(2);
    expect(
      (sql.match(/c\.quantity, c\.optional/g) ?? []).length,
      "both published projections must carry optional",
    ).toBe(2);
  });

  it("an unresolved REVISION save freezes the identity controls too", () => {
    // THE P2 (Codex, #860 4300759930). Round 10 froze the identity controls
    // against the CREATE form's unresolved save; a REVISION save's
    // unresolved state lived entirely inside `MachineReadingEntry`, so the
    // dropdown and the mode buttons stayed live through it.
    //
    // WHAT THAT COSTS: switching after a lost response UNMOUNTS the entry
    // and discards the retry key it is holding. Switch back, press Save,
    // and a new key is minted — appending a duplicate immutable capture if
    // the first request had committed. A control that can destroy the key
    // is part of the gap the key exists to cover.
    const entry = read(ENTRY_SRC);
    expect(entry).toMatch(/onUnresolvedChange\?: \(unresolved: boolean\) => void;/);
    expect(
      entry,
      "the entry must report BOTH edges, or the freeze never lifts",
    ).toMatch(/onUnresolvedChange\?\.\(transportHold\)/);

    const panel = read(PANEL_SRC);
    expect(panel).toMatch(/onUnresolvedChange=\{setRevisionUnresolved\}/);
    expect(panel).toMatch(/const identityFrozen = settingDraftFrozen \|\| revisionUnresolved/);
  });

  it("and the two save paths stay separate flags, combined at use", () => {
    // They are reported by different owners and either can be true alone;
    // merging them into one piece of state would make the host's save and
    // the child's indistinguishable, and clearing one would clear both.
    const panel = read(PANEL_SRC);
    expect(panel).toMatch(/const \[revisionUnresolved, setRevisionUnresolved\] = useState\(false\)/);
    expect(panel).toMatch(/settingDraftFrozen = false,/);
  });

  it("the recorded read reports FAILURE, instead of returning an empty list", () => {
    // ROUND 4'S CONFLATION, ONE LAYER DOWN (Codex, #860 4300759932). The
    // action turned `{ ok: false }` into `[]`, so round 11's refresh
    // installed an empty history over the real one and left the surface
    // marked available — the list that exists to prevent a second capture
    // simply vanished after a save.
    // ASSERTED AS THE RULE, not as the type's current text. The first
    // spelling of this pinned the whole union literally, so round 15 adding
    // `unitNames` — a strictly RICHER success arm — reds a guard whose claim
    // is untouched. That is the fifth time in this lane that a guard of mine
    // has failed on a change that strengthened the thing it guards.
    //
    // What must be true: the result is DISCRIMINATED, the failure arm carries
    // no readings, and every failure path returns it.
    const src = read(SETUP_ACTIONS_SRC);
    // EXTRACTED TO THE FAILURE ARM, which is the declaration's last line.
    //
    // Two wrong anchors before this one, both failing for reasons unrelated
    // to the claim: `;` stopped inside the success arm once it gained a
    // second field, and a blank-line anchor stopped at the JSDoc — because
    // `read()` replaces comment lines with a space, so a documented type has
    // "blank" lines in the middle of it. A guard's extraction is as capable
    // of being wrong as the code it guards.
    const union = src.match(
      /export type ReadingsRead =([\s\S]*?\|\s*\{ ok: false \};)/,
    );
    expect(
      union,
      "no discriminated ReadingsRead with an `{ ok: false }` arm was found — either it is gone, or this guard is blind",
    ).toBeTruthy();
    expect(union![1], "the success arm must carry the readings").toMatch(
      /ok: true;[\s\S]*readings: RecordedReading\[\]/,
    );
    expect(
      union![1],
      "the failure arm must not carry readings — that is the conflation itself",
    ).not.toMatch(/ok: false;[^}]*readings/);

    // AND EVERY FAILURE PATH USES IT: the query's, and not-signed-in.
    expect(src).toMatch(/if \(!got\.ok\) return \{ ok: false \};/);
    // NOT SIGNED IN is a failure too, not an empty treatment.
    expect(src).toMatch(/if \(!scope\) return \{ ok: false \};/);
  });

  it("a failed GUIDANCE read is distinguishable from no previous treatment", () => {
    // ADDED SCOPE, named as such: the enumeration of every
    // failure-to-empty conversion found this one, which Codex did not
    // report. Different harm from the recorded-history case — she loses
    // reference rather than creating a duplicate — and so quieter copy,
    // but the same rule.
    const actions = read(SETUP_ACTIONS_SRC);
    expect(actions).toMatch(/const priorSetupUnavailable = !prior\.ok;/);
    const prior = read(PRIOR_SRC);
    expect(prior).toMatch(/data-testid="machine-prior-setup-unavailable"/);
    expect(
      prior,
      "the failure branch must be checked BEFORE the empty case",
    ).toMatch(/if \(unavailable\) \{[\s\S]{0,900}?if \(readings\.length === 0\) return null;/);
    // AND IT REACHES THE COMPONENT. The forwarding guard caught this
    // missing when the field was added — the fourth instance of that
    // defect in this lane.
    const panel = read(PANEL_SRC);
    expect(panel).toMatch(/unavailable=\{priorSetupUnavailable\}/);
  });

  it("the machine opener keeps the 44px touch floor", () => {
    // DESIGN.md LAW 6, and the third time this lane has hand-rolled a control
    // under the floor (Codex, #860 4296029615, after ebc69ff6). This one is
    // the SOLE entry to machine selection, so the one control she must hit on
    // a phone was the one below it. Button's `sm` composes
    // CONTROL_COMPACT_FINE_POINTER: 44px on every coarse pointer, 32px only
    // behind the explicit pointer-fine gate.
    const src = read(CONN_SRC);
    expect(src).toMatch(/<Button[\s\S]{0,200}data-testid="machine-first-open"/);
    expect(
      src,
      "a hand-rolled className is how the floor was lost the first two times",
    ).not.toMatch(/text-xs[^"]*py-1\.5[^"]*"\s*\n\s*data-testid="machine-first-open"/);
  });

  it("the ENTRY form does NOT reset the monotonic group ordinal", () => {
    // Keeping g1 and g2 on screen while resetting the ordinal to 1 would mint
    // a SECOND g2 on the next "add group". The ordinal is monotonic precisely
    // so a removed group's id is never reused.
    const src = read(ENTRY_SRC);
    expect(src).not.toMatch(/setGroupOrdinal\(1\)/);
  });

  it("and the reset is REACHABLE when nothing is chosen, not nested in the chosen arm", () => {
    // THE ASSERTION ABOVE PASSED WHILE THE FIX DID NOT WORK, which is the
    // whole reason this one exists (Codex, #860 4288424506).
    //
    // The condition `!(chosen && mode)` already covered "nothing chosen". The
    // component carrying it sat INSIDE the chosen-machine arm of the panel's
    // three-way branch, so clearing the machine took the `!chosen` arm and
    // unmounted the entire subtree - the reset included. It never ran on the
    // one case it was written for: the host kept a non-empty draft, and Save
    // recorded those readings under the PREVIOUSLY selected machine as an
    // immutable capture.
    //
    // A PREDICATE IS NOT REACHABILITY, and only position can tell them apart,
    // so position is what this reads. The panel's branch opens at
    // `{selectable.length === 0 ? (`; the reset must come BEFORE it, like the
    // selection note that was moved above the same branch for the same reason.
    const src = read(PANEL_SRC);
    const reset = src.indexOf("<MachineSettingDraftReset");
    const branch = src.indexOf("{selectable.length === 0 ? (");
    const chosenArm = src.indexOf('data-testid="machine-chosen"');

    expect(reset, "the reset must exist").toBeGreaterThan(-1);
    expect(branch, "the panel's three-way branch must be findable").toBeGreaterThan(-1);
    expect(
      reset,
      "the reset is inside the branch, so clearing the machine unmounts it",
    ).toBeLessThan(branch);
    expect(
      reset,
      "the reset is inside the chosen-machine arm and cannot fire on a clear",
    ).toBeLessThan(chosenArm);
    // AND IT IS RENDERED EXACTLY ONCE. A copy left behind in the old position
    // would make the assertions above pass while the stale one still runs on
    // its own schedule.
    expect(src.match(/<MachineSettingDraftReset/g) ?? []).toHaveLength(1);
  });

  it("the reset hands up NULL, not an empty draft with an invented identity", () => {
    // With no machine chosen there is no setup identity, and an empty draft
    // carrying a plausible one is exactly the shape the host is meant to be
    // able to trust.
    const src = read(DRAFT_SRC);
    const reset = src.slice(src.indexOf("export function MachineSettingDraftReset"));
    expect(reset).toMatch(/onSettingDraft\(null\)/);
    expect(reset).toMatch(/return null;/);
  });

  it("the reset renders nothing at all", () => {
    const html = renderToStaticMarkup(
      createElement(MachineSettingDraftReset, { onSettingDraft: () => {} }),
    );
    expect(html).toBe("");
  });
});

// ---------------------------------------------------------------------------
// EVERY CONSUMER OF A BLOCK OR CAPTURE ID BINDS IT TO THE ROUTE
//
// THIS IS THE ENUMERATION, AS A TEST. Rounds 8 and 9 were the same defect
// reached twice: an application lineage check authorizes the ROUTE, and only
// a predicate in a query binds the RECORD to it. Round 8 fixed the writes and
// I reported the read fixed when it was not; round 9's sweep of every action
// taking a block id then found a third site the finding had not named —
// `loadMachineSetupContext`, the panel's own load path, which runs on every
// open (Codex, #860 4297032712 and 4298457378).
//
// A one-off script would not have survived the session. This DISCOVERS the
// functions rather than listing them, so a new one that takes a block id and
// forgets the binding fails here instead of in a later review round.
// ---------------------------------------------------------------------------
describe("every block/capture consumer is bound to the authorized route", () => {
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../..", rel), "utf8");

  const MODULES = [
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
    "lib/machines/machine-queries.ts",
  ];

  /** Exported functions, split out of a module's source by their own header. */
  function exportedFunctions(src: string): Array<{ name: string; body: string }> {
    const out: Array<{ name: string; body: string }> = [];
    // SPLIT ON ANY TOP-LEVEL `export`, not only on an exported FUNCTION.
    //
    // Splitting on functions alone gave each one a body running to the next
    // FUNCTION, so anything between them -- an exported type, a constant --
    // was attributed to the function ABOVE it. That made this guard wrong in
    // both directions: `listSelectableForCaller`, which takes no arguments
    // and touches no block id, was flagged the moment an exported type
    // mentioning `blockId` was declared below it; and before that, the LAST
    // function in the file was credited with every binding in the trailing
    // text, so it could have passed on a predicate it never ran.
    //
    // Ending a body at the next `export` of any kind is what "this function's
    // code" actually means. It is strictly tighter, and the discovery test
    // below is the tripwire against tightening it into blindness.
    const parts = src.split(/\n(?=export )/);
    for (const part of parts) {
      const m = /^export (?:async )?function (\w+)/.exec(part);
      if (m) out.push({ name: m[1]!, body: part });
    }
    return out;
  }

  const TAKES_ID = /\b(blockId|captureId)\b/;

  // What counts as binding the id to the route, in the QUERY rather than in a
  // separate check: a session predicate, the route handed to a command that
  // enforces it, or the id passed to a reader WITH its session.
  const BINDS = [
    /\.eq\("session_id", sessionId\)/,
    /p_session_id/,
    /sessionId:\s*input\.sessionId/,
    /readingsForBlock\(db, input\.blockId, input\.sessionId\)/,
  ];

  it("discovers the consumers, so this test cannot be silently empty", () => {
    // A guard that enumerates nothing passes forever. This pins that the
    // discovery still finds the functions it is meant to police.
    const found: string[] = [];
    for (const rel of MODULES) {
      for (const fn of exportedFunctions(read(rel))) {
        if (TAKES_ID.test(fn.body)) found.push(fn.name);
      }
    }
    expect(found).toContain("loadMachineSetupContext");
    expect(found).toContain("readingsForBlockAction");
    expect(found).toContain("readingsForBlock");
    expect(found.length, "the discovery stopped finding consumers").toBeGreaterThanOrEqual(6);
  });

  it("and every one of them binds the id in a query", () => {
    const unbound: string[] = [];
    for (const rel of MODULES) {
      for (const fn of exportedFunctions(read(rel))) {
        if (!TAKES_ID.test(fn.body)) continue;
        if (!BINDS.some((re) => re.test(fn.body))) unbound.push(`${rel}: ${fn.name}`);
      }
    }
    expect(
      unbound,
      "a function takes a block or capture id without binding it to the route",
    ).toEqual([]);
  });
});
