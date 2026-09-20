import { describe, expect, it } from "vitest";
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
// RESUME-SETUP CONTRACT.
//
// Review caught that pointing at the next task closed only HALF the loop: every
// settings action revalidates in place and none redirects, so an operator who
// completed the task simply stayed there. The flag below is what carries setup
// context onto the task surface. These pin the contract shared between the
// producer (the getting-started CTA) and the consumer (the settings layout) —
// a mismatch between them would silently drop the way back.
// ---------------------------------------------------------------------------
describe("resume-setup contract", () => {
  it("the param name is a shared constant, not duplicated string literals", async () => {
    const { RESUME_SETUP_PARAM } = await import(
      "@/components/onboarding/ResumeSetupLink"
    );
    expect(RESUME_SETUP_PARAM).toBe("setup");
  });

  it("the getting-started CTA appends the flag to the next step's own href", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/getting-started/page.tsx", "utf8");
    // The href must be built from nextStep.href, never hard-coded, so the CTA
    // cannot drift away from the checklist item it claims to point at.
    expect(src).toMatch(/nextStep\.href as string\}\?\$\{RESUME_SETUP_PARAM\}=1/);
  });

  it("the settings layout hosts the way back", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/(app)/settings/layout.tsx", "utf8");
    expect(src).toContain("<ResumeSetupLink />");
  });
});
