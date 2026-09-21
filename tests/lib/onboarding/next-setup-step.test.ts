import { beforeAll, describe, expect, it } from "vitest";
import {
  nextSetupStep,
  type ChecklistItem,
  type GettingStarted,
} from "@/lib/onboarding/getting-started";

// ---------------------------------------------------------------------------
// NEXT SETUP STEP.
//
// Pilot feedback: "finishing one task should lead directly to the next setup
// task". The checklist carried an href INTO each task and nothing onward, so
// completing one returned the operator to the page they had just used.
//
// This function invents no order — it walks the order buildGettingStarted
// already emits. These tests therefore pin the WALK and the two exclusions,
// not a hard-coded sequence of keys, because a sequence pinned here would
// become a second ordering authority competing with the builder.
// ---------------------------------------------------------------------------

const item = (
  key: string,
  status: ChecklistItem["status"],
  href: string | null = `/settings/${key}`,
): ChecklistItem => ({ key, label: `Do ${key}`, explanation: "why", status, href });

const checklist = (...sections: Array<[string, ChecklistItem[]]>): GettingStarted => ({
  sections: sections.map(([key, items]) => ({ key, title: key, items })),
  autoDone: 0,
  autoTotal: 0,
});

describe("nextSetupStep", () => {
  it("returns the first actionable todo, in the builder's own order", () => {
    const c = checklist(
      ["basics", [item("a", "done"), item("b", "todo")]],
      ["booking", [item("c", "todo")]],
    );
    expect(nextSetupStep(c)?.key).toBe("b");
  });

  it("crosses a section boundary rather than stopping at the first section", () => {
    // The whole point of a chain: a finished section must not end the walk.
    const c = checklist(
      ["basics", [item("a", "done"), item("b", "done")]],
      ["booking", [item("c", "todo")]],
    );
    expect(nextSetupStep(c)?.key).toBe("c");
  });

  it("never points at a `review` item", () => {
    // Guidance is read once and completion can never clear it, so pointing
    // "next" at one would stall the chain permanently. Review items are
    // already excluded from autoDone/autoTotal for the same reason.
    const c = checklist(["basics", [item("guide", "review"), item("real", "todo")]]);
    expect(nextSetupStep(c)?.key).toBe("real");
  });

  it("skips a todo with no href and CONTINUES, rather than blocking", () => {
    // An item can be genuinely incomplete and have nowhere to send you (a
    // failed consent read, for instance). Offering a dead CTA is worse than
    // offering none — but it must not stop the operator being sent onward.
    const c = checklist(["basics", [item("unnavigable", "todo", null), item("next", "todo")]]);
    expect(nextSetupStep(c)?.key).toBe("next");
  });

  it("returns null when every item is done, so a set-up studio sees no CTA", () => {
    const c = checklist(["basics", [item("a", "done")]], ["booking", [item("b", "done")]]);
    expect(nextSetupStep(c)).toBeNull();
  });

  it("returns null when the only outstanding items are review or unnavigable", () => {
    const c = checklist(["basics", [item("g", "review"), item("u", "todo", null)]]);
    expect(nextSetupStep(c)).toBeNull();
  });

  it("returns the item itself, so the caller renders label/explanation without re-deriving", () => {
    const c = checklist(["basics", [item("services", "todo", "/settings/services")]]);
    const next = nextSetupStep(c);
    expect(next).toMatchObject({
      key: "services",
      label: "Do services",
      explanation: "why",
      href: "/settings/services",
    });
  });

  it("is pure — calling it twice does not mutate the checklist", () => {
    const c = checklist(["basics", [item("a", "todo")]]);
    const before = JSON.stringify(c);
    nextSetupStep(c);
    nextSetupStep(c);
    expect(JSON.stringify(c)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// TWO ONBOARDING ORDERS, ONE GOVERNING STUDIO.
//
// Review caught that `/getting-started` stays reachable (AccountMenu, search)
// for a studio whose dashboard has handed onboarding to the v2 wizard. Without
// a gate the page would answer "what is next?" from the LEGACY order while the
// studio actually ran ONBOARDING_STEP_ORDER — two authorities, two answers, and
// no way for the operator to tell which was lying. That is the competing-map
// failure this repository keeps re-learning, and the first revision of this
// slice walked straight into it while claiming to avoid it.
// ---------------------------------------------------------------------------
describe("legacyChecklistMayOfferNextStep", () => {
  // THREE gates, all of which must clear. The CTA is an AUTHORITATIVE
  // directive, so each gate answers a different "may it speak?":
  //   owner?            the sequence contains owner-only tasks
  //   legacy flow?      v2 owns the sequence where it is enabled
  //   signals read?     a collapsed read must never become a directive
  let gate: (o: {
    isOwner: boolean;
    onboardingV2Enabled?: boolean | null;
    signalsAvailable: boolean;
  }) => boolean;
  beforeAll(async () => {
    ({ legacyChecklistMayOfferNextStep: gate } = await import(
      "@/lib/onboarding/getting-started"
    ));
  });

  it("1. owner + legacy + signals read -> CTA shown", () => {
    expect(
      gate({ isOwner: true, onboardingV2Enabled: false, signalsAvailable: true }),
    ).toBe(true);
  });

  it("2. owner + v2 -> hidden, because v2 owns that sequence", () => {
    expect(
      gate({ isOwner: true, onboardingV2Enabled: true, signalsAvailable: true }),
    ).toBe(false);
  });

  it("3. non-owner + legacy -> hidden, though the checklist still renders", () => {
    expect(
      gate({ isOwner: false, onboardingV2Enabled: false, signalsAvailable: true }),
    ).toBe(false);
  });

  it("4. non-owner + v2 -> hidden", () => {
    // Previously TRUE: the v2 gate narrowed the audience without asking
    // whether the remaining audience could act.
    expect(
      gate({ isOwner: false, onboardingV2Enabled: true, signalsAvailable: true }),
    ).toBe(false);
  });

  it("5. owner + MISSING optional column -> legacy CTA shown (skew-tolerant)", () => {
    expect(gate({ isOwner: true, signalsAvailable: true })).toBe(true);
    expect(
      gate({ isOwner: true, onboardingV2Enabled: null, signalsAvailable: true }),
    ).toBe(true);
  });

  it("FAILS CLOSED: an unreadable signal hides the CTA even for an eligible owner", () => {
    // The whole point. An owner on the legacy flow is otherwise entitled to the
    // directive; an unreadable signal withdraws it rather than guessing.
    expect(
      gate({ isOwner: true, onboardingV2Enabled: false, signalsAvailable: false }),
    ).toBe(false);
    expect(gate({ isOwner: true, signalsAvailable: false })).toBe(false);
  });

  it("unavailable signals are never rescued by the other gates passing", () => {
    for (const v2 of [true, false, null, undefined]) {
      for (const owner of [true, false]) {
        expect(
          gate({ isOwner: owner, onboardingV2Enabled: v2, signalsAvailable: false }),
        ).toBe(false);
      }
    }
  });
});

describe("nextStepSignalsAvailable covers every collapsing read", () => {
  // A failed read that is NOT in the availability expression silently becomes
  // a legitimate zero and can be selected as the next task. Enumerating the
  // reads here means adding a new collapsing read without adding it to the
  // guard fails this test rather than shipping a confident wrong directive.
  //
  // Source-level on purpose: proving it per-read at runtime would mean mocking
  // Supabase failure for eight reads, which is an ONB-02-sized harness. This
  // pins the contract that matters — every collapsing read is consulted.
  // COMMENTS ARE STRIPPED BEFORE ANY IDENTIFIER IS LOOKED FOR, line before
  // block. Review proved the first draft's hole with a one-line change:
  // commenting out `!clients.error &&` left the guard inert and this test
  // still passed 18/18, because the identifier survived inside the comment.
  // A guard proof that a comment can satisfy is not a proof.
  //
  // Line-before-block is this repository's existing rule: stripping blocks
  // first lets a `/*` sitting inside a line comment swallow real code.
  const guardExpression = async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/onboarding/getting-started.ts", "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    return code.slice(
      code.indexOf("const nextStepSignalsAvailable ="),
      // End anchor is `const notes`: the typed `blocks` declaration was
      // LIFTED above the guard so the embedded-clip check can read it, so
      // slicing to it would now end BEFORE the guard begins.
      code.indexOf("const notes = (noteRows"),
    );
  };

  it("every read whose failure or truncation collapses the signal is consulted", async () => {
    const expr = await guardExpression();
    for (const read of [
      "appointments.error",
      "clients.error",
      "sterile.error",
      "disinfectants.error",
      "payments.error",
      "blocksRes.error",
      "notesRes.error",
      "blocksTruncated",
      "notesTruncated",
      "reactionRowsClipped",
      "treatmentConsent.ok",
    ]) {
      expect(expr, `${read} must gate next-step selection`).toContain(read);
    }
  });

  it("a COMMENTED-OUT guard term fails the proof — line and block form alike", async () => {
    // The negative control for the hole above, run against synthetic source so
    // it cannot pass by accident on a repo that happens to be correct today.
    const strip = (src: string) =>
      src.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(strip("  // !clients.error &&\n  !payments.error")).not.toContain(
      "clients.error",
    );
    expect(strip("  /* !clients.error && */\n  !payments.error")).not.toContain(
      "clients.error",
    );
    // and a live term still survives stripping
    expect(strip("  // note\n  !clients.error &&")).toContain("clients.error");
  });

  it("the bounded reads probe at cap + 1 so truncation is detectable", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/onboarding/getting-started.ts", "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // A bare .limit(N) cannot distinguish "exactly N" from "more than N", which
    // is how a capped read became a confident false negative.
    expect(code).toContain("BLOCK_SIGNAL_CAP + 1");
    expect(code).toContain("NOTE_SIGNAL_CAP + 1");
    expect(code).toMatch(/blocksTruncated\s*=\s*\(blockRows\?\.length \?\? 0\) > BLOCK_SIGNAL_CAP/);
    expect(code).toMatch(/notesTruncated\s*=\s*\(noteRows\?\.length \?\? 0\) > NOTE_SIGNAL_CAP/);
  });

  it("the EMBEDDED rowset is clip-checked at >=, because it cannot be probed", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/onboarding/getting-started.ts", "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // The parent rowsets are probed at cap + 1, so `>` is exact there. An
    // EMBEDDED rowset admits no such probe: the Data API will never return
    // ceiling + 1 embedded rows, so `> CEILING` can never once be true and the
    // check would be dead code. `>=` is the only reachable form, and it is
    // deliberately conservative — exactly-ceiling real rows read as unknown.
    expect(code).toMatch(
      /reactionRowsClipped\s*=\s*blocks\.some\(\s*\(b\)\s*=>\s*\(b\.electrolysis_entries\?\.length \?\? 0\) >= EMBEDDED_ROW_CEILING/,
    );
    expect(code).toMatch(/EMBEDDED_ROW_CEILING = 1_?000/);
  });

  it("the embedded ceiling matches the Data API's configured max_rows", async () => {
    // A constant that drifts from supabase/config.toml stops describing the
    // clip it exists to detect.
    const { readFileSync } = await import("node:fs");
    const cfg = readFileSync("supabase/config.toml", "utf8");
    const configured = Number(/^max_rows\s*=\s*(\d+)/m.exec(cfg)?.[1]);
    const code = readFileSync("lib/onboarding/getting-started.ts", "utf8");
    const pinned = Number(
      /EMBEDDED_ROW_CEILING = ([\d_]+)/.exec(code)?.[1]?.replace(/_/g, ""),
    );
    expect(configured).toBeGreaterThan(0);
    expect(pinned).toBe(configured);
  });

  it("a clipped embed makes the reaction predicate unknown, never 'not done'", () => {
    // The defect in its own terms, as data: a block holding a full embedded
    // page with no reaction in the rows we can see is INDISTINGUISHABLE from a
    // block that genuinely has none. Selecting a next step from it would tell
    // an owner to go chart a reaction they already charted.
    const CEILING = 1_000;
    const clipped = [{ electrolysis_entries: new Array(CEILING).fill({}) }];
    const complete = [{ electrolysis_entries: new Array(CEILING - 1).fill({}) }];
    const isClipped = (rows: Array<{ electrolysis_entries?: unknown[] }>) =>
      rows.some((b) => (b.electrolysis_entries?.length ?? 0) >= CEILING);
    expect(isClipped(clipped)).toBe(true);
    expect(isClipped(complete)).toBe(false);
    // and a block with no embed at all is complete, not unknown
    expect(isClipped([{}])).toBe(false);
  });

  it("the block and note responses keep their error — destructuring must not discard it", async () => {
    // `{ data: blockRows }` at the await site threw the error away; that is
    // precisely how a failed read became an empty studio.
    //
    // COMMENTS ARE STRIPPED FIRST, AND LINE BEFORE BLOCK. The source now
    // QUOTES the old destructuring in a comment explaining why it is gone, so
    // a naive scan matches the explanation and reports the defect it documents
    // — which is exactly what the first draft of this test did. Line-then-block
    // is the repository's existing rule: doing it the other way lets a `/*`
    // inside a line comment swallow real code.
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("lib/onboarding/getting-started.ts", "utf8")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/\{\s*data:\s*blockRows\s*\}/);
    expect(code).not.toMatch(/\{\s*data:\s*noteRows\s*\}/);
    // and the responses themselves are what the guard reads
    expect(code).toContain("blocksRes.error");
    expect(code).toContain("notesRes.error");
  });

  it("getActiveServices is deliberately absent — it throws rather than collapsing", async () => {
    const { readFileSync } = await import("node:fs");
    const q = readFileSync("lib/booking/queries.ts", "utf8");
    // If this ever starts returning [] on error it MUST join the guard above.
    expect(q).toMatch(/getActiveServices[\s\S]{0,400}if \(error\) throw/);
  });
});
