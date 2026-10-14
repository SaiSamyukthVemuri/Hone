import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// HIPAA-READY-01 G-09 (issue #828). The Stripe Customer created on a studio's
// connected account must identify the client by opaque Hone ids only: no
// name, email or phone. This drives the real provisioning function with a
// fake admin client and a captured Stripe call. All values are synthetic.

vi.mock("server-only", () => ({}));

const createCustomer = vi.fn();
vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => ({ customers: { create: createCustomer } }),
  inferStripeLivemode: () => false,
}));

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

function fakeAdmin() {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "create_or_claim_stripe_customer_provisioning") {
        return {
          data: [
            {
              already_provisioned: false,
              should_execute_stripe_call: true,
              out_idempotency_key: "idem_synthetic",
              attempt_id: "33333333-3333-4333-8333-333333333333",
              out_processing_claim_token: "claim_synthetic",
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    }),
  };
}

describe("Stripe customer provisioning sends no client identity", () => {
  beforeEach(() => {
    createCustomer.mockReset();
    createCustomer.mockResolvedValue({ id: "cus_synthetic" });
  });

  it("creates the customer with opaque ids only", async () => {
    const { getOrCreateStripeCustomerForCardOnFile } = await import(
      "@/lib/stripe/setup-intent"
    );
    const result = await getOrCreateStripeCustomerForCardOnFile({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: fakeAdmin() as any,
      studioId: STUDIO,
      clientId: CLIENT,
      stripeAccountId: "acct_synthetic",
      stripeLivemode: false,
    });

    expect(result).toEqual({ ok: true, stripeCustomerId: "cus_synthetic" });
    expect(createCustomer).toHaveBeenCalledTimes(1);
    const [body, opts] = createCustomer.mock.calls[0];

    expect(Object.keys(body).sort()).toEqual(["description", "metadata"]);
    expect(body.metadata).toEqual({
      hone_studio_id: STUDIO,
      hone_client_id: CLIENT,
      hone_source: "portal_card_on_file",
    });
    expect(body.description).toBe(`Hone studio ${STUDIO} / client ${CLIENT}`);
    for (const forbidden of ["name", "email", "phone", "address", "shipping"]) {
      expect(body).not.toHaveProperty(forbidden);
    }
    expect(opts).toEqual({
      stripeAccount: "acct_synthetic",
      idempotencyKey: "idem_synthetic:opaque_ids_v2",
    });
  });

  // Codex P2 on #857: the stale-claim path replays an attempt's ORIGINAL
  // idempotency key. An attempt that reached Stripe before this change sent
  // hone_client_name under that key; Stripe rejects the same key with
  // different parameters. The fake below behaves that way.
  it("a pre-change attempt replayed after deploy is not blocked by Stripe idempotency", async () => {
    const seen = new Map<string, string>();
    createCustomer.mockImplementation(
      async (body: unknown, opts: { idempotencyKey: string }) => {
        const payload = JSON.stringify(body);
        const prior = seen.get(opts.idempotencyKey);
        if (prior !== undefined && prior !== payload) {
          throw new Error(
            "Keys for idempotent requests can only be used with the same parameters they were first used with.",
          );
        }
        seen.set(opts.idempotencyKey, payload);
        return { id: "cus_synthetic" };
      },
    );
    // The request a pre-change worker sent under the attempt's bare key.
    seen.set(
      "idem_synthetic",
      JSON.stringify({
        description: `Hone studio ${STUDIO} / client ${CLIENT}`,
        metadata: {
          hone_studio_id: STUDIO,
          hone_client_id: CLIENT,
          hone_client_name: "Synthetic Person",
          hone_source: "portal_card_on_file",
        },
      }),
    );

    const { getOrCreateStripeCustomerForCardOnFile } = await import(
      "@/lib/stripe/setup-intent"
    );
    const result = await getOrCreateStripeCustomerForCardOnFile({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: fakeAdmin() as any,
      studioId: STUDIO,
      clientId: CLIENT,
      stripeAccountId: "acct_synthetic",
      stripeLivemode: false,
    });

    expect(result).toEqual({ ok: true, stripeCustomerId: "cus_synthetic" });
    // A retry inside the new version still collapses onto one request.
    const again = await getOrCreateStripeCustomerForCardOnFile({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: fakeAdmin() as any,
      studioId: STUDIO,
      clientId: CLIENT,
      stripeAccountId: "acct_synthetic",
      stripeLivemode: false,
    });
    expect(again).toEqual({ ok: true, stripeCustomerId: "cus_synthetic" });
  });

  it("no source file writes a client name into Stripe metadata", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/stripe/setup-intent.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/hone_client_name|clientName/);
  });
});
