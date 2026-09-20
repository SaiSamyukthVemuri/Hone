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
  // The CTA needs BOTH gates to clear: the operator must be an owner (the
  // sequence contains owner-only tasks — /settings/consent answers "Only studio
  // owners can manage consent forms", and services/payments/profile gate the
  // same way), and the legacy checklist rather than the v2 wizard must own the
  // sequence for that studio. The full truth table is pinned because a
  // one-sided gate is exactly what shipped and had to be corrected twice.
  let gate: (o: { isOwner: boolean; onboardingV2Enabled?: boolean | null }) => boolean;
  beforeAll(async () => {
    ({ legacyChecklistMayOfferNextStep: gate } = await import(
      "@/lib/onboarding/getting-started"
    ));
  });

  it("1. owner + legacy -> CTA shown", () => {
    expect(gate({ isOwner: true, onboardingV2Enabled: false })).toBe(true);
  });

  it("2. owner + v2 -> CTA hidden, because v2 owns that sequence", () => {
    expect(gate({ isOwner: true, onboardingV2Enabled: true })).toBe(false);
  });

  it("3. non-owner + legacy -> CTA hidden, though the checklist still renders", () => {
    // The directive is withheld, not the page: a practitioner keeps the
    // readiness view and simply is not told to go do owner-only work.
    expect(gate({ isOwner: false, onboardingV2Enabled: false })).toBe(false);
  });

  it("4. non-owner + v2 -> CTA hidden", () => {
    // Previously this case returned TRUE: the v2 gate narrowed the audience
    // without asking whether the remaining audience could act, so a
    // practitioner in a v2 studio got a LEGACY-ordered step pointing at a page
    // that refuses them. Both gates now have to clear.
    expect(gate({ isOwner: false, onboardingV2Enabled: true })).toBe(false);
  });

  it("5. owner + MISSING optional column -> legacy CTA shown (skew-tolerant)", () => {
    // The field is optional for schema-skew tolerance and such a studio is
    // genuinely on the legacy flow; silence there would strand its owner.
    expect(gate({ isOwner: true })).toBe(true);
    expect(gate({ isOwner: true, onboardingV2Enabled: null })).toBe(true);
  });

  it("non-owner is refused regardless of the flag's value", () => {
    for (const v of [true, false, null, undefined]) {
      expect(gate({ isOwner: false, onboardingV2Enabled: v })).toBe(false);
    }
  });
});
