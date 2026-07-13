import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, seedSession, seedStudio, type SeededStudio } from "./helpers/harness";
import { E2E_SUPABASE_URL, E2E_SERVICE_ROLE_KEY } from "@/e2e/helpers/local-env";

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
