import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #198 pins: Chloe iPad retest fixes.
const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const TAB = read("components/profile-tab.ts");
const FORM = read("app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx");

describe("1. Messages tab actually opens", () => {
  it("isProfileTab accepts messages (the bug: validator omitted it)", () => {
    expect(TAB).toMatch(/value === "messages" \|\|/);
  });
});

describe("3. charting chips", () => {
  it("no reaction <select> remains; reactions are merged chips in the unified observations & skin response box", () => {
    // No single-select reaction dropdown anywhere.
    expect(FORM).not.toMatch(/<select[\s\S]{0,200}reactionType/);
    // Charting unification: the former separate "Client / skin response" group is
    // gone. There is ONE merged box, titled via the unified heading, rendering
    // MERGED_OBSERVATION_CHIPS (observation presets + reaction labels) as
    // multi-select toggles on observationChips.
    expect(FORM).toMatch(/\{OBSERVATIONS_RESPONSE_HEADING\}/);
    expect(FORM).not.toMatch(/\{CLIENT_RESPONSE_HEADING\}/);
    const box = FORM.slice(FORM.indexOf("{OBSERVATIONS_RESPONSE_HEADING}"));
    expect(box).toMatch(/MERGED_OBSERVATION_CHIPS\.map/);
    expect(box).toMatch(/isChipSelected\(draft\.observationChips, c\)/);
    expect(box).toMatch(/toggleFindingChip\(draft\.observationChips, c\)/);
    // The reaction is no longer a separate single-select row.
    expect(FORM).not.toMatch(/REACTION_TYPES\.map/);
    // A legacy reaction_type is preserved on save ONLY while its label chip stays
    // selected (never invented from chips), never a separate single-select field.
    expect(FORM).toMatch(
      /isChipSelected\([\s\S]{0,60}reactionTypeLabel\(draft\.reactionType as ReactionType\)/,
    );
  });
});
