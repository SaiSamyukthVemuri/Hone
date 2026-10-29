import { describe, expect, it } from "vitest";

import { nativeFieldGroups } from "@/lib/machines/charting";
import type { MachineProfile } from "@/lib/machines/profile-contract";
import {
  rangeWarningsForDraft,
  unconfirmedWarnings,
  warningKey,
} from "@/lib/machines/range-warnings";
import { draftKey } from "@/lib/machines/setting-groups";
import type { SettingGroupDraft } from "@/lib/machines/setting-groups";
import { SYNTHETIC_DEMO_PROFILE } from "@/lib/machines/synthetic-profile";

// HON-8 - a value outside a documented range WARNS and needs the
// practitioner's explicit confirmation before the save; it is never clamped and
// never refused (Sam's range decision, via OPS).
//
// NOT CLAIMED: that the confirmation is RECORDED. That needs migration 0267
// applied and a wired call; this is the client-side gate only.

function withRanges(
  ranges: NonNullable<MachineProfile["modes"][number]["fields"][number]["ranges"]>,
): MachineProfile {
  return {
    ...SYNTHETIC_DEMO_PROFILE,
    modes: SYNTHETIC_DEMO_PROFILE.modes.map((m) =>
      m.key === "galvanic"
        ? {
            ...m,
            fields: m.fields.map((f) => (f.key === "current" ? { ...f, ranges } : f)),
          }
        : m,
    ),
  };
}

const PUBLISHED = [
  { min: 10, max: 200, class: "published-specification" as const, evidence: "synthetic-demo" },
];

function draftWith(profile: MachineProfile, id: string, current: string): {
  mode: MachineProfile["modes"][number];
  groups: SettingGroupDraft[];
} {
  const mode = profile.modes.find((m) => m.key === "galvanic")!;
  const fg = nativeFieldGroups(profile, mode);
  const f = fg[0]!.fields.find((x) => x.key === "current")!;
  return {
    mode,
    groups: [
      { id, recorded: false, channels: [], values: { [draftKey(fg[0]!.key, f)]: current } },
    ],
  };
}

describe("range warnings for a draft", () => {
  it("names a value above a published maximum, with the code and the value as typed", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "250");
    const w = rangeWarningsForDraft(profile, mode, groups);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      groupId: "g1",
      fieldKey: "current",
      value: 250,
      code: "outside_published_specification",
    });
  });

  it("names a value below the minimum too", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "3");
    expect(rangeWarningsForDraft(profile, mode, groups)).toHaveLength(1);
  });

  it("is silent inside the range, at the bounds, and for a blank field", () => {
    const profile = withRanges(PUBLISHED);
    for (const v of ["10", "100", "200", ""]) {
      const { mode, groups } = draftWith(profile, "g1", v);
      expect(rangeWarningsForDraft(profile, mode, groups)).toEqual([]);
    }
  });

  it("carries a recommended-protocol and a documentation-discrepancy range under their own codes", () => {
    const rec = withRanges([
      { max: 50, class: "recommended-protocol", evidence: "synthetic-demo" },
    ]);
    const a = draftWith(rec, "g1", "60");
    expect(rangeWarningsForDraft(rec, a.mode, a.groups)[0]?.code).toBe(
      "recommended_protocol_only",
    );
    const disc = withRanges([
      { max: 50, class: "published-specification", evidence: "synthetic-demo", discrepancy: "sources disagree" },
    ]);
    const b = draftWith(disc, "g1", "60");
    expect(rangeWarningsForDraft(disc, b.mode, b.groups)[0]?.code).toBe(
      "documentation_discrepancy",
    );
  });

  it("never clamps: the value reported is the typed number, not a bound", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "999");
    expect(rangeWarningsForDraft(profile, mode, groups)[0]?.value).toBe(999);
  });

  it("does not turn a refusal into a warning: a malformed value is left to the existing path", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "-5");
    expect(rangeWarningsForDraft(profile, mode, groups)).toEqual([]);
  });
});

describe("confirmation", () => {
  it("every warning is unconfirmed until its own key is confirmed", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "250");
    const w = rangeWarningsForDraft(profile, mode, groups);
    expect(unconfirmedWarnings(w, new Set())).toHaveLength(1);
    expect(unconfirmedWarnings(w, new Set([warningKey(w[0]!)]))).toEqual([]);
  });

  it("a confirmation of 250 does not cover 300: the key binds the value", () => {
    const profile = withRanges(PUBLISHED);
    const first = draftWith(profile, "g1", "250");
    const confirmed = new Set(
      rangeWarningsForDraft(profile, first.mode, first.groups).map(warningKey),
    );
    const changed = draftWith(profile, "g1", "300");
    const w = rangeWarningsForDraft(profile, changed.mode, changed.groups);
    expect(unconfirmedWarnings(w, confirmed)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// INITIAL SETUP SAVES (Codex, #1259 4408870613). Creating a treatment area
// saves its settings in the same press of Save, through MachineSettingDraft,
// which reports `blocking` to the host. The gate must live there too.
// ---------------------------------------------------------------------------
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pruneConfirmations,
  rangeConfirmationBlocking,
} from "@/lib/machines/range-warnings";

describe("the create-mode draft is blocked until each out-of-range value is confirmed", () => {
  it("blocks with a sentence while any warning is unconfirmed, and says how many", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "250");
    const w = rangeWarningsForDraft(profile, mode, groups);
    const msg = rangeConfirmationBlocking(w, new Set());
    expect(msg).toMatch(/confirm the value/i);
    const two = [...w, { ...w[0]!, groupId: "g2" }];
    expect(rangeConfirmationBlocking(two, new Set())).toContain("2 values");
  });

  it("does not block once every warning is confirmed, nor when there are none", () => {
    const profile = withRanges(PUBLISHED);
    const { mode, groups } = draftWith(profile, "g1", "250");
    const w = rangeWarningsForDraft(profile, mode, groups);
    expect(rangeConfirmationBlocking(w, new Set(w.map(warningKey)))).toBeNull();
    expect(rangeConfirmationBlocking([], new Set())).toBeNull();
  });

  it("drops a confirmation whose value is no longer in the draft, so 250 -> 300 -> 250 needs a fresh tick", () => {
    const profile = withRanges(PUBLISHED);
    const a = draftWith(profile, "g1", "250");
    const confirmed = new Set(rangeWarningsForDraft(profile, a.mode, a.groups).map(warningKey));
    const b = draftWith(profile, "g1", "100"); // back in range: no warnings
    expect(pruneConfirmations(confirmed, rangeWarningsForDraft(profile, b.mode, b.groups)).size).toBe(0);
  });

  it("the create-mode component reports that blocking to its host (source contract)", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../components/machines/machine-setting-draft.tsx"),
      "utf8",
    );
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    expect(code).toContain("rangeConfirmationBlocking(");
    expect(code).toContain("<RangeConfirmationList");
  });
});
