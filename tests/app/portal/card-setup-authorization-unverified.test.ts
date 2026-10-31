import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR B - REMEDIATION SURFACE.
//
// app/portal/payment-method-actions.ts is the client's own "add a card" path.
// It is the surface where a wrong answer is most costly in a way that is not
// financial: telling a client who HAS a current authorization that they are
// unsigned - or worse, sending them to re-sign - on the strength of a database
// timeout is exactly the deadlock this finding describes. On a signature-read
// failure the re-sign cannot succeed either, so the client is stuck.
//
// It is ALSO a money surface: `cardAuth.signatureId` is stamped onto the
// SetupIntent, so an unverifiable authorization must not mint one.
//
// This drives the real action. The SetupIntent creator is a tripwire.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  cardAuthKind: "authorization_unverified" as string,
  setupIntentCalls: 0,
  rows: {} as Record<string, unknown>,
  writes: [] as string[],
}));

vi.mock("@/lib/consent/current-card-authorization", () => ({
  getCardAuthorizationStatus: async () => ({
    kind: h.cardAuthKind,
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));

vi.mock("@/lib/portal/session", () => ({
  getCurrentPortalSession: async () => ({
    studioId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
  }),
}));

vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

vi.mock("@/lib/stripe/setup-intent", () => ({
  createCardOnFileSetupIntent: async () => {
    h.setupIntentCalls += 1;
    throw new Tripwire("SetupIntent created on an unverifiable authorization");
  },
  getOrCreateStripeCustomerForCardOnFile: async () => ({
    ok: true,
    stripeCustomerId: "cus_test",
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    let table = "";
    const read = () => ({ data: h.rows[table] ?? null, error: null });
    const write = (op: string) => {
      h.writes.push(`${table}.${op}`);
      throw new Tripwire(`WRITE ${op} on ${table}`);
    };
    q.select = () => q;
    q.eq = () => q;
    q.is = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.maybeSingle = async () => read();
    q.single = async () => read();
    q.then = (resolve: (v: unknown) => unknown) => resolve(read());
    q.insert = () => write("insert");
    q.update = () => write("update");
    q.upsert = () => write("upsert");
    q.delete = () => write("delete");
    return {
      from(t: string) {
        table = t;
        return q;
      },
      rpc: (name: string) => {
        h.writes.push(`rpc.${name}`);
        throw new Tripwire(`RPC ${name}`);
      },
    };
  },
}));

const { createCardSetupIntentAction } = await import(
  "@/app/portal/payment-method-actions"
);

beforeEach(() => {
  h.cardAuthKind = "authorization_unverified";
  h.setupIntentCalls = 0;
  h.writes = [];
  h.rows = {
    clients: {
      id: "22222222-2222-4222-8222-222222222222",
      archived_at: null,
    },
    studio_payment_settings: {
      stripe_account_id: "acct_test",
      stripe_account_status: "enabled",
      stripe_livemode: false,
    },
  };
});

describe("portal add-card on an unverifiable authorization", () => {
  it("refuses without creating a SetupIntent", async () => {
    const res = await createCardSetupIntentAction();
    expect(res.ok).toBe(false);
    expect(h.setupIntentCalls).toBe(0);
    expect(h.writes).toEqual([]);
  });

  it("does not tell the client they are unsigned, and does not ask them to re-sign", async () => {
    const res = await createCardSetupIntentAction();
    const message = res.ok ? "" : res.error;

    // The three lies this branch exists to prevent.
    expect(message).not.toMatch(/re-?sign/i);
    expect(message).not.toMatch(/unsigned|has not signed|not signed/i);
    expect(message).not.toMatch(/out of date|no longer current/i);
    // No studio-blaming claim either: the template may be perfectly fine.
    expect(message).not.toMatch(/template/i);
    // No database text reaches a client.
    expect(message).not.toMatch(/57014|statement timeout|PGRST|supabase/i);
    // Retryable, so the client recovers the moment the read succeeds.
    expect(message).toMatch(/try again/i);
  });

  it("CONTROL: the SetupIntent tripwire fires when authorization IS current", async () => {
    h.cardAuthKind = "signed_current";
    await expect(createCardSetupIntentAction()).rejects.toBeInstanceOf(
      Tripwire,
    );
    expect(h.setupIntentCalls).toBe(1);
  });
});
