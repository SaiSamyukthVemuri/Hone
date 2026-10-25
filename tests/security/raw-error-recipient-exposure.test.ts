import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureConsole } from "../lib/sms/helpers/log-capture";

// ===========================================================================
// MSG-LOG-RAW-ERROR-3. Investigation of #1106's raw-error log paths at
// production 9488913d, as SYNTHETIC reproductions.
//
// Each case plants a synthetic recipient address and phone in the error a
// provider or Postgres would hand back, drives the REAL function, and asserts
// what reached the console. Nothing here reads production logs or customer
// data, sends a message, or touches a hosted service.
//
// Three paths wrote raw error text and #1138's source contract could not see
// them, because the value reaches the log call under a name that is not
// error-like (a local `raw`, a result's `detail`, a stringified `message`):
//   * lib/sessions/block-command-errors.ts and session-command-errors.ts, the
//     default "unmapped RPC failure" logger (the Postgres message);
//   * lib/stripe/setup-intent.ts, whose `detail` (a Postgres message or the
//     Stripe SDK's message) app/portal/payment-method-actions.ts logs;
//   * lib/billing/auto-payment-receipt.ts, which logged String(err) when the
//     receipt sender threw synchronously.
// The cases for those three fail on 9488913d and pass with this change. The
// remaining cases pin paths that were examined and are NOT reachable, so a
// regression there fails here rather than in a log drain.
// ===========================================================================

vi.mock("server-only", () => ({}));

const createCustomer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/stripe/server", () => ({
  getStripe: () => ({
    customers: { create: (...a: unknown[]) => createCustomer(...a) },
    setupIntents: { create: (...a: unknown[]) => createCustomer(...a) },
  }),
  inferStripeLivemode: () => false,
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(async () => {}) }));

const EMAIL = "leak.probe@example.test";
const PHONE = "+1 555 010 0199";
const HOSTILE = `could not deliver to ${EMAIL} / ${PHONE}`;

function expectClean(text: string) {
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain("leak.probe");
  expect(text.replace(/\D/g, "")).not.toContain("5550100199");
}

let logs: ReturnType<typeof captureConsole>;
beforeEach(() => {
  logs = captureConsole();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// DEFECT 1: the command-error mappers' default logger wrote the Postgres message
// ---------------------------------------------------------------------------
describe("block and session command mappers log a code, never the Postgres message", () => {
  const pgError = { code: "22P02", message: `invalid input syntax for type uuid: "${EMAIL}"` };

  it("mapBlockCommandError: an unmapped failure that quotes a value logs only its code", async () => {
    const { mapBlockCommandError, GENERIC_BLOCK_COMMAND_ERROR } = await import("@/lib/sessions/block-command-errors");
    expect(mapBlockCommandError(pgError)).toBe(GENERIC_BLOCK_COMMAND_ERROR);
    expectClean(logs.text());
    expect(logs.text()).toContain("22P02");
  });

  it("mapSessionCommandError: the same", async () => {
    const { mapSessionCommandError, GENERIC_SESSION_COMMAND_ERROR } = await import("@/lib/sessions/session-command-errors");
    expect(mapSessionCommandError(pgError)).toBe(GENERIC_SESSION_COMMAND_ERROR);
    expectClean(logs.text());
    expect(logs.text()).toContain("22P02");
  });

  it("a message that is not a database error's own (no code) logs 'unknown', not its text", async () => {
    const { mapBlockCommandError } = await import("@/lib/sessions/block-command-errors");
    const { mapSessionCommandError } = await import("@/lib/sessions/session-command-errors");
    mapBlockCommandError({ message: HOSTILE });
    mapSessionCommandError({ message: HOSTILE, code: HOSTILE });
    expectClean(logs.text());
    expect(logs.text()).toContain("unknown");
  });

  it("known outcomes still map to their wording, and an empty error logs a fixed marker", async () => {
    const { mapBlockCommandError } = await import("@/lib/sessions/block-command-errors");
    const { mapSessionCommandError } = await import("@/lib/sessions/session-command-errors");
    expect(mapBlockCommandError({ message: "stale_block_version" })).toMatch(/changed elsewhere/);
    expect(mapSessionCommandError({ message: "finalized" })).toMatch(/finalized/);
    expect(logs.text()).toBe("");
    mapBlockCommandError(null);
    mapSessionCommandError(undefined);
    expect(logs.text()).toContain("empty_rpc_error");
  });

  it("a caller-supplied logger receives the closed code, not the message", async () => {
    const { mapBlockCommandError } = await import("@/lib/sessions/block-command-errors");
    const { mapSessionCommandError } = await import("@/lib/sessions/session-command-errors");
    const seen: string[] = [];
    mapBlockCommandError(pgError, (c) => seen.push(c));
    mapSessionCommandError(pgError, (c) => seen.push(c));
    expect(seen).toEqual(["22P02", "22P02"]);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2: setup-intent's `detail` (logged by the portal action) carried the
// Postgres message and the Stripe SDK's message
// ---------------------------------------------------------------------------
describe("Stripe customer provisioning returns a closed detail", () => {
  type Rpc = { data: unknown; error: { code?: string; message: string } | null };
  function admin(handlers: { claim?: Rpc; complete?: Rpc }) {
    const claim: Rpc = handlers.claim ?? {
      data: [
        {
          already_provisioned: false,
          should_execute_stripe_call: true,
          out_idempotency_key: "idem_synthetic",
          attempt_id: "attempt_synthetic",
          out_processing_claim_token: "claim_synthetic",
        },
      ],
      error: null,
    };
    return {
      rpc: vi.fn(async (name: string) =>
        name === "create_or_claim_stripe_customer_provisioning" ? claim : (handlers.complete ?? { data: null, error: null }),
      ),
    };
  }
  async function run(a: ReturnType<typeof admin>) {
    const { getOrCreateStripeCustomerForCardOnFile } = await import("@/lib/stripe/setup-intent");
    return getOrCreateStripeCustomerForCardOnFile({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      admin: a as any,
      studioId: "studio_synthetic",
      clientId: "client_synthetic",
      stripeAccountId: "acct_synthetic",
      stripeLivemode: false,
    });
  }
  const CLOSED_DETAIL = /^[A-Za-z0-9_]+(?::[A-Za-z0-9_]+)*$/;

  beforeEach(() => {
    createCustomer.mockReset();
  });

  it("a Postgres message quoting a value on the claim RPC", async () => {
    const r = await run(admin({ claim: { data: null, error: { code: "XX000", message: HOSTILE } } }));
    expect(r).toMatchObject({ ok: false, error: "provisioning_rpc_failed" });
    const detail = (r as { detail?: string }).detail ?? "";
    expectClean(detail);
    expect(detail).toMatch(CLOSED_DETAIL);
    expect(detail).toContain("XX000");
  });

  it("the missing-email refusal (P0002)", async () => {
    const r = await run(admin({ claim: { data: null, error: { code: "P0002", message: HOSTILE } } }));
    expect(r).toMatchObject({ ok: false, error: "missing_email" });
    const detail = (r as { detail?: string }).detail ?? "";
    expectClean(detail);
    expect(detail).toBe("P0002");
  });

  it("the Stripe SDK's own message", async () => {
    const stripeErr = Object.assign(new Error(HOSTILE), { type: "StripeInvalidRequestError", code: "email_invalid" });
    createCustomer.mockImplementation(async () => { throw stripeErr; });
    const r = await run(admin({}));
    expect(r).toMatchObject({ ok: false, error: "stripe_customer_create_failed" });
    const detail = (r as { detail?: string }).detail ?? "";
    expectClean(detail);
    expect(detail).toMatch(CLOSED_DETAIL);
    expect(detail).toContain("StripeInvalidRequestError");
    expect(detail).toContain("email_invalid");
  });

  it("a thrown value that is not an Error, and one whose message is the address", async () => {
    createCustomer.mockImplementation(async () => { throw HOSTILE; });
    expectClean(((await run(admin({}))) as { detail?: string }).detail ?? "");
    createCustomer.mockImplementation(async () => { throw new TypeError(HOSTILE); });
    expectClean(((await run(admin({}))) as { detail?: string }).detail ?? "");
  });

  it("the completion RPC", async () => {
    createCustomer.mockResolvedValue({ id: "cus_synthetic" });
    const r = await run(admin({ complete: { data: null, error: { code: "23505", message: HOSTILE } } }));
    expect(r).toMatchObject({ ok: false, error: "complete_rpc_failed" });
    const detail = (r as { detail?: string }).detail ?? "";
    expectClean(detail);
    expect(detail).toContain("23505");
  });

  it("the SetupIntent create failure (logged as `error` by the portal action)", async () => {
    createCustomer.mockImplementation(async () => { throw Object.assign(new Error(HOSTILE), { type: "StripeInvalidRequestError", code: "parameter_invalid_empty" }); });
    const { createCardOnFileSetupIntent } = await import("@/lib/stripe/setup-intent");
    const r = await createCardOnFileSetupIntent({
      studioId: "studio_synthetic",
      clientId: "client_synthetic",
      stripeAccountId: "acct_synthetic",
      stripeCustomerId: "cus_synthetic",
      cardAuthorizationSignatureId: "sig_synthetic",
    });
    expect(r.ok).toBe(false);
    const error = (r as { error: string }).error;
    expectClean(error);
    expect(error).toBe("setup_intent_create_failed:error:StripeInvalidRequestError:parameter_invalid_empty");
  });

  it("a line written from every detail is clean (the portal action logs `detail` whole)", async () => {
    createCustomer.mockImplementation(async () => { throw Object.assign(new Error(HOSTILE), { type: "StripeCardError", code: "card_declined" }); });
    const r = await run(admin({}));
    console.error(JSON.stringify({ event: "card_setup_customer_failed", reason: (r as { error?: string }).error, detail: (r as { detail?: string }).detail }));
    expectClean(logs.text());
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3: a synchronous throw from the receipt sender was logged as String(err)
// ---------------------------------------------------------------------------
describe("the automatic receipt logs a class when the sender throws", () => {
  const ARGS = { attemptId: "att-1", studioId: "st-1", practitionerId: "pr-1" };
  const CHARGE = {
    ok: true,
    outcome: "succeeded",
    stripePaymentIntentId: "pi_1",
    stripeChargeId: "ch_1",
    committedNow: true,
  } as const;

  it("a synchronous throw quoting the recipient", async () => {
    const { autoSendReceiptAfterCharge } = await import("@/lib/billing/auto-payment-receipt");
    const outcome = await autoSendReceiptAfterCharge({
      charge: CHARGE,
      ...ARGS,
      send: (() => {
        throw new Error(`transport failed for ${EMAIL} ${PHONE}`);
      }) as never,
      register: ((p: Promise<unknown>) => void p) as never,
    });
    expect(outcome).toMatchObject({ attempted: true, threw: true });
    expectClean(logs.text());
    expect(logs.text()).toContain("auto_payment_receipt_threw");
    expect(logs.text()).toContain("errorClass");
  });

  it("an asynchronous rejection (already logged as a class) stays clean", async () => {
    const { autoSendReceiptAfterCharge } = await import("@/lib/billing/auto-payment-receipt");
    await autoSendReceiptAfterCharge({
      charge: CHARGE,
      ...ARGS,
      send: (async () => {
        throw new Error(`transport failed for ${EMAIL} ${PHONE}`);
      }) as never,
      register: ((p: Promise<unknown>) => void p) as never,
    });
    expect(logs.text()).toContain("errorClass");
    expectClean(logs.text());
  });
});

// ---------------------------------------------------------------------------
// NOT REACHABLE: examined, and pinned so a regression fails here
// ---------------------------------------------------------------------------
describe("examined and not reachable", () => {
  it("SMS: an exception whose message is the recipient logs one fixed tag", async () => {
    const { logSmsFailure } = await import("@/lib/sms/send-appointment");
    logSmsFailure({
      appointmentId: "appt_synthetic",
      smsType: "confirmation",
      error: `exception:${HOSTILE}`,
      retryable: false,
    });
    await new Promise((r) => setTimeout(r, 0));
    expectClean(logs.text());
    expect(logs.text()).toContain("sms_send_exception");
  });

  it("SMS: a provider tag that is not in the closed set collapses", async () => {
    const { logSmsFailure } = await import("@/lib/sms/send-appointment");
    logSmsFailure({ appointmentId: "a", smsType: "confirmation", error: HOSTILE, retryable: true });
    expectClean(logs.text());
    expect(logs.text()).toContain("provider_or_transport");
  });

  it("recordOpsAlert: a message and details carrying a plain address and phone are redacted before the console line", async () => {
    // The file-level mock of the alert writer is for the receipt cases above;
    // THIS case drives the real one, or it would assert on an empty console.
    vi.doUnmock("@/lib/ops/alerts");
    vi.resetModules();
    vi.doMock("@/lib/supabase/admin-server", () => ({
      createAdminClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
    }));
    vi.doMock("@/lib/ops/alert-email", () => ({ notifyCriticalOpsAlert: vi.fn(async () => {}) }));
    const { recordOpsAlert } = await import("@/lib/ops/alerts");
    await recordOpsAlert({
      severity: "warning",
      event: "synthetic_event",
      message: HOSTILE,
      safeDetails: { thrown: HOSTILE },
    });
    // Non-vacuous: a line WAS written, and it is the redacted one.
    expect(logs.text()).toContain("synthetic_event");
    expect(logs.text()).toContain("[redacted]");
    expectClean(logs.text());
  });

  it("Sentry: console output never leaves the app, and an exception value is redacted", async () => {
    const { scrubBreadcrumb, scrubErrorEvent } = await import("@/lib/observability/sentry-scrub");
    expect(scrubBreadcrumb({ category: "console", message: HOSTILE })).toBeNull();
    const scrubbed = scrubErrorEvent({
      type: undefined,
      exception: { values: [{ type: "Error", value: HOSTILE }] },
    } as never);
    expect(JSON.stringify(scrubbed)).toContain("[Redacted]");
    expectClean(JSON.stringify(scrubbed));
  });

  it("the team invitation failure line carries a bare identifier at most", async () => {
    const src = (await import("node:fs")).readFileSync("app/(app)/settings/team/actions.ts", "utf8");
    expect(src).toMatch(/ERROR_NAME_RE = \/\^\[A-Za-z_\]\{1,64\}\$\//);
  });
});
