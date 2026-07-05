import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGettingStarted,
  type GettingStartedSignals,
} from "@/lib/onboarding/getting-started";

// PR #215: Getting Started / onboarding checklist. Auto-detected
// where data proves a step happened; Review guidance otherwise; no
// blocking modal; pilot wording only.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const PAGE = read("app/(app)/getting-started/page.tsx");
const HELPER = read("lib/onboarding/getting-started.ts");
const DASH = read("app/(app)/dashboard/page.tsx");

function signals(over: Partial<GettingStartedSignals> = {}): GettingStartedSignals {
  return {
    studioName: "Willow Electrolysis",
    practitionerName: "Chloe Vemuri LE",
    hasSlug: true,
    activeServices: 3,
    appointments: 5,
    clients: 2,
    sessions: 4,
    treatmentAreas: 6,
    hasFrequency: true,
    hasProbe: true,
    hasProbeLot: true,
    hasReactionOrTolerance: true,
    hasNextVisitNote: true,
    sterileItems: 1,
    disinfectants: 1,
    paymentAttempts: 2,
    runtimeLivemode: false,
    ...over,
  };
}

describe("buildGettingStarted", () => {
  it("renders all six sections", () => {
    const out = buildGettingStarted(signals());
    expect(out.sections.map((s) => s.key)).toEqual([
      "basics",
      "booking",
      "charting",
      "records",
      "daily",
      "payments",
    ]);
  });

  it("auto-detected items flip done/todo from data; progress counts auto items only", () => {
    const all = buildGettingStarted(signals());
    expect(all.autoDone).toBe(all.autoTotal);
    const none = buildGettingStarted(
      signals({
        sterileItems: 0,
        disinfectants: 0,
        hasProbeLot: false,
        appointments: 0,
        paymentAttempts: 0,
      }),
    );
    expect(none.autoDone).toBe(all.autoTotal - 5);
    // Review items never count toward progress.
    const reviewCount = none.sections
      .flatMap((s) => s.items)
      .filter((i) => i.status === "review").length;
    expect(reviewCount).toBeGreaterThan(0);
  });

  it("sterile/disinfectant/probe-lot signals mark their items done", () => {
    const out = buildGettingStarted(signals());
    const find = (k: string) =>
      out.sections.flatMap((s) => s.items).find((i) => i.key === k)!;
    expect(find("sterile-item").status).toBe("done");
    expect(find("disinfectant").status).toBe("done");
    expect(find("probe-lot").status).toBe("done");
    const empty = buildGettingStarted(
      signals({ sterileItems: 0, disinfectants: 0, hasProbeLot: false }),
    );
    const findE = (k: string) =>
      empty.sections.flatMap((s) => s.items).find((i) => i.key === k)!;
    expect(findE("sterile-item").status).toBe("todo");
    expect(findE("disinfectant").status).toBe("todo");
    expect(findE("probe-lot").status).toBe("todo");
  });

  it("payments items are state-driven by runtime mode (test runtime)", () => {
    const out = buildGettingStarted(signals());
    const items = out.sections.find((s) => s.key === "payments")!.items;
    expect(items.map((i) => i.key)).toEqual([
      "test-payments",
      "payment-mode",
      "legal-approved",
      "stripe-connect",
    ]);
    // Test runtime: live is off IN THIS ENVIRONMENT (a fact about the
    // deployment, not a product-wide claim) and stays a todo.
    expect(items[1].label).toBe("Live payments are off in this environment");
    expect(items[1].status).toBe("review");
    expect(items[1].explanation).toMatch(/No real cards can be charged here/);
  });

  it("payments items are state-driven by runtime mode (live runtime)", () => {
    const out = buildGettingStarted(signals({ runtimeLivemode: true, paymentAttempts: 1 }));
    const items = out.sections.find((s) => s.key === "payments")!.items;
    expect(items.map((i) => i.key)).toEqual([
      "payments-used",
      "payment-mode",
      "legal-approved",
      "stripe-connect",
    ]);
    expect(items[0].label).toBe("Payments available (live)");
    expect(items[0].status).toBe("done");
    expect(items[1].label).toBe("Live payments enabled");
    expect(items[1].status).toBe("done");
    // Live-capable surface: never the stale pre-launch claims.
    const all = items.map((i) => i.label + " " + i.explanation).join(" ");
    expect(all).not.toMatch(/Live payments are off(?! in this environment)/);
    expect(all).not.toMatch(/review pending|checklist pending/i);
  });
});

describe("placement + page", () => {
  it("dashboard card links to /getting-started with progress; not a modal", () => {
    expect(DASH).toMatch(/href="\/getting-started"/);
    expect(DASH).toMatch(/Getting started/);
    expect(DASH).toMatch(/steps\s*\n?\s*complete/);
    // No modal/dialog component; the design-note comment may mention
    // the word.
    expect(PAGE).not.toMatch(/<dialog|showModal|role="dialog"|<Modal/);
  });

  it("the route is a protected server page resolving the studio", () => {
    expect(PAGE).toMatch(/getCurrentPractitionerWithStudio/);
    expect(PAGE).not.toMatch(/"use client"/);
  });

  it("all checklist surfaces render: sections + first consultation (no future-onboarding section)", () => {
    expect(PAGE).toMatch(/Ready for first real consultation/);
    for (const line of [
      "Client can book",
      "Probe lot can be recorded",
      "Aftercare\\/risks can be marked",
      "Payments run in the studio",
    ]) {
      expect(PAGE).toMatch(new RegExp(line));
    }
    // PR #216: the future-onboarding section was removed; Getting
    // Started is about the current user's setup only.
    expect(PAGE).not.toMatch(/Before onboarding another practitioner or studio/);
    expect(PAGE).not.toMatch(/Chloe has completed a real consultation test/);
    expect(PAGE).not.toMatch(/onboarding another/i);
  });

  it("items render status badges, explanations, and Open links", () => {
    expect(PAGE).toMatch(/Done/);
    expect(PAGE).toMatch(/To do/);
    expect(PAGE).toMatch(/Review/);
    expect(PAGE).toMatch(/Open →/);
  });
});

describe("safety", () => {
  it("read-only signals loader; no writes", () => {
    expect(HELPER).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
  });

  it("no compliance or live-payment readiness claims", () => {
    for (const src of [PAGE, HELPER]) {
      expect(src).not.toMatch(/\bcompliant\b/i);
      expect(src).not.toMatch(/inspection approved/i);
      expect(src).not.toMatch(/\bcertified\b/i);
      expect(src).not.toMatch(/\bguaranteed\b/i);
      expect(src).not.toMatch(/ready for live payments/i);
      expect(src).not.toMatch(/revenue enabled/i);
    }
    expect(PAGE).toMatch(/public-health\/legal review/);
    expect(PAGE).toMatch(/Payments run in the studio/);
  });
});
