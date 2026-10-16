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
    expect(read(FORM)).toMatch(/if \(!saveUnresolved\) setPendingSaveKey\(null\)/);
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
    const src = read(ENTRY_SRC);
    expect(src).toMatch(/setGroups\(clearedForNextCapture\)/);
    expect(
      src,
      "resetting to firstGroup() is what renumbered her groups",
    ).not.toMatch(/setGroups\(firstGroup\(\)\)/);
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
    expect(src).toMatch(/const frozen = !canEditDraft\(save\)/);
    expect(src).toMatch(/frozen=\{frozen\}/);
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
    expect(src).toMatch(/const draftFrozen = saveUnresolved/);
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
    const src = read(ACTIONS_SRC);
    expect(src).toMatch(
      /if \(blockReadErr \|\| !blockRow\) \{[\s\S]{0,1400}?return withSetup\s*\?\s*\{[\s\S]{0,200}?unresolved: true as const,/,
    );
    expect(src).toMatch(/error: INITIAL_SAVE_UNRESOLVED,/);
  });

  it("and the form already freezes on exactly that signal", () => {
    // The action's new outcome is only worth anything if the host acts on
    // it. This is the same field the lost-response path sets, which is why
    // the two cases now behave identically — they are indistinguishable to
    // the practitioner and must be.
    const src = read(FORM_SRC);
    expect(src).toMatch(/if \("unresolved" in res && res\.unresolved\) setSaveUnresolved\(true\)/);
    expect(src).toMatch(/const draftFrozen = saveUnresolved/);
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
    expect(src).toMatch(/disabled=\{selectable\.length === 0 \|\| selectionPending\}/);
    expect(src).toMatch(/disabled=\{selectionPending\}/);
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
