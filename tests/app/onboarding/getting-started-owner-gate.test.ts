import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-44 F1. Payment ledger rows are readable by the studio owner only (0254).
// A non-owner's head-count of payment_charge_attempts would return 0 with no
// error and turn a finished step into a false "to do". The read must not be
// issued for a non-owner, and the item must render as informational.

const reads: string[] = [];
let paymentResult: { count: number | null; error: unknown } = { count: 3, error: null };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      reads.push(table);
      const result =
        table === "payment_charge_attempts"
          ? { data: null, ...paymentResult }
          : { data: [], count: 1, error: null };
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "order", "limit"]) builder[m] = () => builder;
      builder.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return builder;
    },
  }),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/booking/queries", () => ({ getActiveServices: async () => [{}] }));
vi.mock("@/lib/consent/launch-readiness", () => ({
  CONSENT_SETTINGS_HREF: "/settings/consent",
  getTreatmentConsentReadiness: async () => ({ ok: true, ready: true }),
}));

import {
  buildGettingStarted,
  getGettingStartedSignals,
} from "@/lib/onboarding/getting-started";

const STUDIO = { id: "studio-1", name: "Synthetic Studio", slug: "synthetic" };

function paymentsItem(paymentAttempts: number | null) {
  const signals = {
    studioName: "Synthetic Studio",
    practitionerName: "Synthetic",
    hasSlug: true,
    activeServices: 1,
    appointments: 1,
    clients: 1,
    sessions: 1,
    treatmentAreas: 1,
    hasFrequency: true,
    hasProbe: true,
    hasProbeLot: true,
    hasReactionOrTolerance: true,
    hasNextVisitNote: true,
    liveTreatmentConsent: true,
    sterileItems: 1,
    disinfectants: 1,
    paymentAttempts,
    runtimeLivemode: false,
    nextStepSignalsAvailable: true,
  };
  const out = buildGettingStarted(signals);
  return {
    item: out.sections.find((s) => s.key === "payments")!.items[0],
    autoDone: out.autoDone,
    autoTotal: out.autoTotal,
  };
}

beforeEach(() => {
  reads.length = 0;
  paymentResult = { count: 3, error: null };
});

describe("getting started: payment signal is owner-only (HON-44 F1)", () => {
  it("a non-owner issues NO payment_charge_attempts read and gets paymentAttempts null", async () => {
    const s = await getGettingStartedSignals(STUDIO, "Synthetic", { viewerIsOwner: false });
    expect(reads).not.toContain("payment_charge_attempts");
    expect(s.paymentAttempts).toBeNull();
  });

  it("a non-owner's missing payment read does not make the next-step signals unavailable", async () => {
    const s = await getGettingStartedSignals(STUDIO, "Synthetic", { viewerIsOwner: false });
    expect(s.nextStepSignalsAvailable).toBe(true);
  });

  it("null renders as an informational review item and leaves the progress counts alone", () => {
    const unknown = paymentsItem(null);
    const done = paymentsItem(2);
    expect(unknown.item.status).toBe("review");
    expect(unknown.item.href).toBeNull();
    expect(unknown.autoTotal).toBe(done.autoTotal - 1);
    expect(unknown.autoDone).toBe(done.autoDone - 1);
  });

  it("the owner still reads the ledger: attempts show done, none show to-do, a read error reports signals unavailable", async () => {
    const withRows = await getGettingStartedSignals(STUDIO, "Synthetic", { viewerIsOwner: true });
    expect(reads).toContain("payment_charge_attempts");
    expect(withRows.paymentAttempts).toBe(3);
    expect(paymentsItem(3).item.status).toBe("done");
    expect(paymentsItem(0).item.status).toBe("todo");

    paymentResult = { count: null, error: { message: "boom" } };
    const failed = await getGettingStartedSignals(STUDIO, "Synthetic", { viewerIsOwner: true });
    expect(failed.nextStepSignalsAvailable).toBe(false);
  });
});
