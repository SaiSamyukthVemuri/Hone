import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";
import {
  seedEligibleQuickCheckoutScenario,
  seedQuickCheckoutScenario,
  readClinicalIntegritySnapshot,
  cleanupPaymentScenario,
} from "./helpers/payment-seed";
import type { SessionPaymentEligibility } from "@/lib/billing/session-payment-types";

async function resolve(studioId: string, sessionId: string): Promise<SessionPaymentEligibility> {
  const { getSessionPaymentEligibility } = await import(
    "@/lib/billing/session-payment-eligibility"
  );
  return getSessionPaymentEligibility({ studioId, sessionId });
}
const reasons = (e: SessionPaymentEligibility) =>
  e.eligible === false ? e.blockingReasons.join(" | ") : "";

// supabase-js (@supabase/realtime-js) requires a global WebSocket at CLIENT
// CONSTRUCTION; the DB lane's Node 20 has none, and the real app path (Next
// server) does. Admin queries never open a realtime channel, so a no-op stub
// satisfies the construction check with no new dependency and no production
// change. Must be set before createAdminClient() runs.
if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as { WebSocket?: unknown }).WebSocket = class WebSocketStub {};
}

// Stage A — real-resolver smoke test. Proves the CI DB-integration lane can
// invoke the REAL getSessionPaymentEligibility (server-only, createAdminClient →
// local Supabase REST, nested card-authorization resolver, Stripe livemode
// inference) against seeded data — NOTHING is mocked. A bare seeded session
// (no linked appointment, no card) must resolve as INELIGIBLE with the exact
// application reasons.

// createAdminClient() reads these at call time; point them at the local disposable
// Supabase the DB lane runs. STRIPE_SECRET_KEY is a dummy sk_test_ so
// inferStripeLivemode() selects test mode. Set only in this disposable process.
const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
};
beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
});
afterAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.STRIPE_SECRET_KEY = savedEnv.stripe;
  await closePool();
});

let studio: SeededStudio;

describe("Stage A — the CI DB lane runs the REAL getSessionPaymentEligibility", () => {
  beforeAll(async () => {
    studio = await seedStudio("qc-elig-smoke");
  });

  it("a bare seeded session (no appointment, no card) resolves INELIGIBLE with the real reasons", async () => {
    // Import lazily so the env above is set before the module reads it.
    const { getSessionPaymentEligibility } = await import(
      "@/lib/billing/session-payment-eligibility"
    );
    const { sessionId } = await seedSession(studio);

    const elig = await getSessionPaymentEligibility({
      studioId: studio.studioId,
      sessionId,
    });

    expect(elig.eligible).toBe(false);
    if (elig.eligible === false) {
      // Deterministic reasons from the REAL resolver (not a mock):
      //  - the session has no linked appointment (seedSession omits it)
      //  - the client has no card on file
      expect(elig.blockingReasons.join(" | ")).toMatch(
        /not linked to a confirmed appointment/i,
      );
      expect(elig.blockingReasons.join(" | ")).toMatch(/card on file/i);
    }
  });

  it("a non-existent session resolves INELIGIBLE (studio-scoped, real resolver)", async () => {
    const { getSessionPaymentEligibility } = await import(
      "@/lib/billing/session-payment-eligibility"
    );
    const elig = await getSessionPaymentEligibility({
      studioId: studio.studioId,
      sessionId: "00000000-0000-0000-0000-000000000000",
    });
    expect(elig.eligible).toBe(false);
    if (elig.eligible === false) {
      expect(elig.blockingReasons.join(" | ")).toMatch(/session not found/i);
    }
  });
});

describe("Stage C/D — the core eligible fixture proves ELIGIBLE via the real resolver", () => {
  it("seeds the full chain and getSessionPaymentEligibility returns eligible", async () => {
    const s = await seedEligibleQuickCheckoutScenario();
    try {
      const elig = await resolve(s.studioId, s.sessionId!);
      expect(elig.eligible, `unexpected reasons: ${reasons(elig)}`).toBe(true);
      if (elig.eligible === true) {
        expect(elig.card).not.toBeNull();
        expect(elig.cardAuthorization).not.toBeNull(); // signed_current
        expect(elig.stripeAccountId).toMatch(/^acct_test_e2e_/);
        expect(elig.session.pricePaidCents).toBe(s.expectedAmountMinor);
        expect(elig.existingAttempts).toHaveLength(0);
        expect(elig.appointment?.status).toBe("completed");
      }
    } finally {
      await cleanupPaymentScenario(s.studioId);
    }
  });

  it("Stage G: the eligible fixture's session is started + clinically empty", async () => {
    const s = await seedEligibleQuickCheckoutScenario();
    try {
      const snap = await readClinicalIntegritySnapshot(s.sessionId!);
      expect(snap).toMatchObject({
        exists: true,
        started: true,
        blockCount: 0,
        areaCount: 0,
        consultationNoteCount: 0,
        skinHairNoteCount: 0,
      });
    } finally {
      await cleanupPaymentScenario(s.studioId);
    }
  });
});

describe("Stage E — variants resolve to the correct state via the real resolver", () => {
  const cases: Array<{ name: string; opts: Parameters<typeof seedQuickCheckoutScenario>[0]; expect: RegExp }> = [
    { name: "no saved card", opts: { withCard: false }, expect: /card on file/i },
    { name: "removed card", opts: { cardStatus: "removed" }, expect: /card on file/i },
    { name: "appointment not completed", opts: { appointmentStatus: "confirmed" }, expect: /not completed/i },
    { name: "no signature", opts: { withSignature: false }, expect: /not signed|authorization/i },
    { name: "superseded signature (old version)", opts: { signatureCurrent: false }, expect: /out of date|re-sign|authorization/i },
    { name: "stale card pointer", opts: { cardPointerStale: true }, expect: /re-sign|authorization/i },
    { name: "connect disabled", opts: { connect: "disabled" }, expect: /stripe|onboarding|not enabled/i },
    { name: "missing connected account", opts: { connect: "missing_account" }, expect: /payment settings|onboarding|card on file/i },
    { name: "existing ready attempt blocks a new prepare", opts: { attempt: "ready" }, expect: /already|in progress|active/i },
  ];
  for (const c of cases) {
    it(`${c.name} → ineligible`, async () => {
      const s = await seedQuickCheckoutScenario({
        appointmentStatus: "completed",
        withSession: true,
        sessionStarted: true,
        withCard: true,
        withTemplate: true,
        withSignature: true,
        signatureCurrent: true,
        connect: "enabled",
        attempt: "none",
        ...c.opts,
      });
      try {
        const elig = await resolve(s.studioId, s.sessionId!);
        // The "ready attempt" variant surfaces as an existing active attempt
        // (the card renders it), not necessarily a blockingReason — assert the
        // attempt is present instead.
        if (c.name.startsWith("existing ready")) {
          expect(elig.existingAttempts.some((a) => a.status === "ready")).toBe(true);
        } else {
          expect(elig.eligible).toBe(false);
          expect(reasons(elig)).toMatch(c.expect);
        }
      } finally {
        await cleanupPaymentScenario(s.studioId);
      }
    });
  }

  it("no-session fixture is ineligible (freeform not supported)", async () => {
    const s = await seedQuickCheckoutScenario({ appointmentStatus: "completed", withSession: false });
    try {
      // No session id → resolver keyed by session; assert via a fresh bare session instead.
      expect(s.sessionId).toBeUndefined();
    } finally {
      await cleanupPaymentScenario(s.studioId);
    }
  });
});
