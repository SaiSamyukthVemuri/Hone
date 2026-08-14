import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, closePool } from "./helpers/harness";

// Finding 2: DELAYED-PROVIDER concurrency. Drives the REAL single-flight claim
// RPC end to end through deliverWelcomeEmail, with the provider send made SLOW
// and COUNTED, to prove that two concurrent deliveries for one studio result in
// exactly ONE provider delivery attempt (the loser sees already_in_progress and
// never touches the transport). This complements the pure-claim stale-recovery
// tests in welcome-email-claim.db.test.ts.

const hoisted = vi.hoisted(() => ({ sends: 0 }));

// Mock ONLY the transport factory, the claim/record state adapters and the
// claim/record RPCs run for real against the local DB via the shim admin below.
vi.mock("@/lib/email/client", () => ({
  FROM_ADDRESS: "Hone <hello@hone.care>",
  getResendTransport: () => ({
    emails: {
      send: async () => {
        hoisted.sends += 1;
        // A slow provider send still in flight while the concurrent caller runs.
        await new Promise((r) => setTimeout(r, 250));
        return { error: null };
      },
    },
  }),
}));

import { deliverWelcomeEmail } from "@/lib/email/send-welcome";

afterAll(async () => {
  await closePool();
});

beforeEach(() => {
  hoisted.sends = 0;
});

// A minimal service-role client shim: the welcome adapters only call
// admin.rpc(fn, params). Route those to the real RPCs over the admin pool.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admin: any = {
  rpc: async (fn: string, params: Record<string, unknown>) => {
    if (fn === "claim_welcome_email_attempt") {
      const r = await adminQuery(
        `select public.claim_welcome_email_attempt($1) as v`,
        [params.p_studio_id],
      );
      return { data: r.rows[0].v ?? null, error: null };
    }
    if (fn === "record_welcome_email_result") {
      const r = await adminQuery(
        `select public.record_welcome_email_result($1, $2, $3) as v`,
        [params.p_studio_id, params.p_attempt_id, params.p_status],
      );
      return { data: r.rows[0].v, error: null };
    }
    throw new Error(`unexpected rpc ${fn}`);
  },
};

async function seedBareStudio(): Promise<string> {
  const studioId = randomUUID();
  await adminQuery(
    `insert into public.studios (id, name, owner_email) values ($1, $2, $3)`,
    [studioId, "Delivery Race", `owner-${studioId.slice(0, 8)}@harness.local`],
  );
  return studioId;
}

function deliver(studioId: string) {
  return deliverWelcomeEmail(admin, {
    studioId,
    ownerDisplayName: null,
    ownerEmail: "owner@harness.local",
    studioName: "Delivery Race",
    bookingUrl: "",
  });
}

describe("deliverWelcomeEmail: one provider delivery under concurrency", () => {
  it("two concurrent deliveries -> ONE provider send, one 'sent', one 'already_in_progress'", async () => {
    const studioId = await seedBareStudio();
    const [a, b] = await Promise.all([deliver(studioId), deliver(studioId)]);

    // Exactly one provider delivery attempt despite the slow, overlapping send.
    expect(hoisted.sends).toBe(1);
    // One caller sent; the other lost the single-flight claim and sent nothing.
    expect([a, b].filter((x) => x === "sent")).toHaveLength(1);
    expect([a, b].filter((x) => x === "already_in_progress")).toHaveLength(1);

    // Final persisted state reflects the one genuine send.
    const st = await adminQuery(
      `select welcome_email_status, welcome_email_last_sent_at
         from public.studio_onboarding where studio_id=$1`,
      [studioId],
    );
    expect(st.rows[0].welcome_email_status).toBe("sent");
    expect(st.rows[0].welcome_email_last_sent_at).not.toBeNull();
  });
});
