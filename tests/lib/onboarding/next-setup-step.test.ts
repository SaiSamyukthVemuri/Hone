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
  it("stays silent when the v2 wizard owns onboarding for an owner", async () => {
    const { legacyChecklistMayOfferNextStep } = await import(
      "@/lib/onboarding/getting-started"
    );
    expect(
      legacyChecklistMayOfferNextStep({ isOwner: true, onboardingV2Enabled: true }),
    ).toBe(false);
  });

  it("still offers a next step to a NON-owner, whom the v2 wizard never gates", async () => {
    const { legacyChecklistMayOfferNextStep } = await import(
      "@/lib/onboarding/getting-started"
    );
    expect(
      legacyChecklistMayOfferNextStep({ isOwner: false, onboardingV2Enabled: true }),
    ).toBe(true);
  });

  it("offers a next step when v2 is off", async () => {
    const { legacyChecklistMayOfferNextStep } = await import(
      "@/lib/onboarding/getting-started"
    );
    expect(
      legacyChecklistMayOfferNextStep({ isOwner: true, onboardingV2Enabled: false }),
    ).toBe(true);
  });

  it("treats an ABSENT column as not-enabled — schema skew must fail toward the legacy flow", async () => {
    const { legacyChecklistMayOfferNextStep } = await import(
      "@/lib/onboarding/getting-started"
    );
    // The type is optional for skew tolerance; a studio without the column is
    // genuinely on the legacy flow, so silence there would strand it.
    expect(legacyChecklistMayOfferNextStep({ isOwner: true })).toBe(true);
    expect(
      legacyChecklistMayOfferNextStep({ isOwner: true, onboardingV2Enabled: null }),
    ).toBe(true);
  });
});
