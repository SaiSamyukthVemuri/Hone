import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Custom-area keystroke duplication hotfix (Chloe, production feedback).
//
// REPRODUCED DEFECT. `MultiAreaEditor` passed its `addArea` (an APPEND) as the
// `AreaPicker` `onChange`, and `AreaPicker.setCustom` called `onChange` on every
// keystroke. Typing "Glabella" therefore appended eight selected rows, "G",
// "Gl", "Gla", "Glab", "Glabe", "Glabel", "Glabell", "Glabella", and the write
// action persisted all eight as
// canonical `session_block_areas` rows (`normalizeAreaSet` dedupes only on
// (area, laterality), and every prefix is a distinct area).
//
// These are SOURCE-CONTRACT guards. The behavioural proof that typing adds
// nothing and Enter/Add adds exactly one row is the pure-logic suite
// (tests/lib/area-input.test.ts) plus the real-browser specs
// (e2e/custom-area-commit.spec.ts, desktop + iPhone profile).

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const PICKER = read("components/area-picker.tsx");
const EDITOR = read("components/multi-area-editor.tsx");
const MULTI_PICKER = read("components/multi-area-picker.tsx");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");
const COPY_DRAFT = read("components/copy-draft-card.tsx");
const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");

describe("AreaPicker custom text is draft-only in explicit-commit mode", () => {
  it("typing NEVER notifies the parent when customCommit is explicit", () => {
    // setCustom stores the draft and returns early, the `onChange` that the
    // multi-area editor treats as an APPEND is unreachable from a keystroke.
    expect(PICKER).toMatch(/function setCustom\(next: string\) \{[\s\S]*?setCustomValue\(next\);[\s\S]*?if \(explicit\) return;[\s\S]*?onChange\(next\);/);
  });

  it("revealing the Other input is not a commit in explicit mode", () => {
    // The legacy pickOther() called onChange(customValue), which would append
    // the draft the moment the practitioner tapped "Other".
    expect(PICKER).toMatch(/function pickOther\(\) \{[\s\S]*?if \(explicit\) \{[\s\S]*?setOtherSelected\(\(open\) => !open\);[\s\S]*?return;/);
  });

  it("commit is guarded: blank/whitespace-only can never commit", () => {
    expect(PICKER).toMatch(/function commitCustom\(\)/);
    expect(PICKER).toMatch(/if \(!canCommitCustomArea\(customValue\)\) return;/);
    expect(PICKER).toMatch(/disabled=\{!canCommit\}/);
  });

  it("offers BOTH commit affordances: an Add area button and Enter", () => {
    expect(PICKER).toMatch(/onClick=\{commitCustom\}/);
    expect(PICKER).toMatch(/if \(e\.key === "Enter"\) \{[\s\S]*?e\.preventDefault\(\);[\s\S]*?commitCustom\(\);/);
  });

  it("Enter is prevented from submitting the surrounding settings-block form", () => {
    expect(PICKER).toMatch(/e\.preventDefault\(\);/);
  });

  it("clears the draft after an accepted commit (so repeated Enter is a no-op)", () => {
    expect(PICKER).toMatch(/const accepted = onCommitCustom\(customValue\);[\s\S]*?if \(accepted\) setCustomValue\(""\);/);
  });

  it("defaults to the legacy live contract so existing callers are unchanged", () => {
    expect(PICKER).toMatch(/customCommit = "live"/);
    expect(PICKER).toMatch(/const explicit = customCommit === "explicit";/);
  });

  it("canonical chips still add immediately in both modes", () => {
    expect(PICKER).toMatch(/function pickCanonical\(area: string\) \{[\s\S]*?onChange\(area\);/);
  });
});

describe("MultiAreaEditor commits custom areas explicitly", () => {
  it("still uses the shared AreaPicker, now in explicit-commit mode", () => {
    expect(EDITOR).toMatch(/<AreaPicker/);
    expect(EDITOR).toMatch(/customCommit="explicit"/);
    expect(EDITOR).toMatch(/onCommitCustom=\{commitCustomArea\}/);
  });

  it("routes every add through the single commit rule (append + dedupe)", () => {
    expect(EDITOR).toMatch(/import \{ commitAreaToSet \} from "@\/lib\/sessions\/area-input";/);
    expect(EDITOR).toMatch(/function addArea\(next: string\) \{[\s\S]*?commitAreaToSet\(value, next\)/);
    expect(EDITOR).toMatch(/function commitCustomArea\(raw: string\): boolean \{[\s\S]*?commitAreaToSet\(value, raw\)/);
  });

  it("tells the practitioner when the area was already in the block", () => {
    expect(EDITOR).toMatch(/is already in this settings block/);
    expect(EDITOR).toMatch(/role="status"/);
  });

  it("clears that notice on ANY edit to the set, so it cannot state a false fact", () => {
    // The notice asserts something about the CURRENT set. Removing the very
    // area it names, or changing a laterality, must retract it.
    for (const fn of ["setLaterality", "remove", "applyToAll"]) {
      const body = EDITOR.slice(EDITOR.indexOf(`function ${fn}(`));
      expect(body.slice(0, 260), `${fn} must clear the notice`).toMatch(/setNotice\(null\);/);
    }
  });

  it("keeps per-area laterality, remove, and apply-to-all intact", () => {
    expect(EDITOR).toMatch(/function setLaterality/);
    expect(EDITOR).toMatch(/function remove/);
    expect(EDITOR).toMatch(/function applyToAll/);
  });
});

describe("no other surface can append a partial keystroke value", () => {
  it("the treatment-plan MultiAreaPicker already commits explicitly (unchanged)", () => {
    expect(MULTI_PICKER).toMatch(/function addCustom\(\)/);
    expect(MULTI_PICKER).toMatch(/onClick=\{addCustom\}/);
    expect(MULTI_PICKER).toMatch(/onChange=\{\(e\) => setCustomDraft\(e\.target\.value\)\}/);
    // Typing only touches local draft state, there is no onChange(...) call in
    // the input's own change handler.
    expect(MULTI_PICKER).not.toMatch(/setCustomDraft\(e\.target\.value\);\s*onChange\(/);
  });

  it("both MultiAreaEditor mount points inherit the fix (charting form + copy draft)", () => {
    expect(FORM).toMatch(/<MultiAreaEditor/);
    expect(COPY_DRAFT).toMatch(/<MultiAreaEditor/);
    // Neither mount point renders its own raw AreaPicker, so the editor is the
    // single custom-area entry point for charting.
    expect(FORM).not.toMatch(/<AreaPicker/);
    expect(COPY_DRAFT).not.toMatch(/<AreaPicker/);
  });

  it("the remaining live-controlled 'Other' input carries a do-not-append warning", () => {
    // components/chip-selector.tsx still calls onChange per keystroke. That is
    // safe ONLY because every parent holds a single controlled string. The
    // comment is the guard against a future parent wiring an append handler to
    // it and reintroducing this exact class of defect.
    const CHIP = read("components/chip-selector.tsx");
    expect(CHIP).toMatch(/DO NOT wire this component's `onChange` to a handler that APPENDS/);
    // Every current consumer replaces a single value; none appends to a list.
    const consumers = [
      "app/(app)/clients/[id]/sessions/[sessionId]/simplified-entry-form.tsx",
      "components/log-electrolysis-entry-form.tsx",
      "components/log-laser-entry-form.tsx",
    ];
    for (const rel of consumers) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/<ChipSelector[\s\S]{0,400}?onChange=\{[^}]*\.\.\./);
    }
  });

  it("the server still drops blank areas and rejects duplicate (area, side) pairs", () => {
    // Unchanged server contract: the fix is client-side only, and this pins
    // that the existing server guard is still the backstop.
    expect(ACTIONS).toMatch(/if \(area\.length === 0\) continue;/);
    expect(ACTIONS).toMatch(/const key = area\.toLowerCase\(\) \+ ":" \+ lat;/);
  });
});
