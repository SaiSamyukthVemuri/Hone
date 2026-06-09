import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #172. Source-grep tests pin the load-bearing shape of the
// session payment eligibility helper. The runtime tests for the
// helper's branching behavior live in the prepare-action source
// tests below (which exercise the helper indirectly via the
// action's discriminated-result contract). These tests guard
// against a refactor that drops one of the structural invariants:
//
//   * the helper imports "server-only" so a future client tree
//     accidentally importing it fails at build time
//   * it uses createAdminClient (service-role) so the FK targets
//     across client_payment_methods + client_consent_signatures +
//     payment_charge_attempts can all be read in one server call
//   * the chargeability proxy is the explicit
//     (sessions.appointment_id IS NOT NULL,
//      appointments.status='completed',
//      sessions.started_at IS NOT NULL) per audit Audit 1
//   * the card_authorization gate is the shared
//     getCardAuthorizationStatus helper (PR #170), not an inline
//     re-query
//   * the duplicate-attempt check reads payment_charge_attempts
//     scoped to (studio, session, charge_reason='session_payment')
//     and the active-status set matches the partial unique index
//     payment_charge_attempts_active_session_payment_uniq from
//     migration 0073
//   * the helper returns a discriminated union mirroring the
//     manual fee shape

const HELPER_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-eligibility.ts",
);
const HELPER = readFileSync(HELPER_PATH, "utf8");

const TYPES_PATH = path.resolve(
  __dirname,
  "../../../lib/billing/session-payment-types.ts",
);
const TYPES = readFileSync(TYPES_PATH, "utf8");

describe("getSessionPaymentEligibility: server boundary + admin client", () => {
  it("imports 'server-only' to lock the helper out of client trees", () => {
    expect(HELPER).toMatch(/^import "server-only";/);
  });

  it("uses createAdminClient (not the RLS client)", () => {
    expect(HELPER).toMatch(/createAdminClient/);
  });

  it("uses inferStripeLivemode to scope the card lookup", () => {
    // Reuses the PR #168 dormancy guard. In test mode livemode is
    // false; live mode is structurally blocked elsewhere.
    expect(HELPER).toMatch(/inferStripeLivemode\(\)/);
  });
});

describe("getSessionPaymentEligibility: chargeability proxy (Audit 1)", () => {
  it("session lookup is scoped by (studio_id, session_id)", () => {
    expect(HELPER).toMatch(
      /\.from\("sessions"\)[\s\S]{0,400}\.eq\("studio_id",\s*args\.studioId\)[\s\S]{0,200}\.eq\("id",\s*args\.sessionId\)|\.from\("sessions"\)[\s\S]{0,400}\.eq\("id",\s*args\.sessionId\)[\s\S]{0,200}\.eq\("studio_id",\s*args\.studioId\)/,
    );
  });

  it("the chargeability proxy reads sessions.started_at and appointments.status", () => {
    expect(HELPER).toMatch(/started_at/);
    expect(HELPER).toMatch(/appointment\.status !== "completed"|appointmentSummary\.status !== "completed"/);
  });

  it("rejects a session without an appointment link with a freeform-specific message", () => {
    expect(HELPER).toMatch(/Freeform-session payments are not supported in v1/);
  });

  it("rejects an unstarted session before checking the appointment status", () => {
    expect(HELPER).toMatch(/Session has not started yet/);
  });
});

describe("getSessionPaymentEligibility: card + authorization gates", () => {
  it("requires an active client_payment_methods row for (studio, client, livemode)", () => {
    const block =
      HELPER.match(
        /\.from\("client_payment_methods"\)[\s\S]*?\.maybeSingle\(\)/,
      )?.[0] ?? "";
    expect(block).toMatch(/\.eq\("studio_id",\s*args\.studioId\)/);
    expect(block).toMatch(/\.eq\("client_id",\s*clientId\)/);
    expect(block).toMatch(/\.eq\("status",\s*"active"\)/);
    expect(block).toMatch(/\.eq\("stripe_livemode",\s*livemode\)/);
  });

  it("the card-missing message tells the practitioner what to do", () => {
    expect(HELPER).toMatch(
      /Client must add a card on file before a session payment can be prepared/,
    );
  });

  it("uses the PR #177 charge-ready helper (which wraps the PR #170 base)", () => {
    // PR #172 used the base PR #170 helper; PR #177 tightened the
    // gate so a stale client_payment_methods.card_authorization
    // _signature_id pointer (the docs/16 §5.11 finding) blocks
    // prepare with a clear remedy. The charge-ready helper wraps
    // the base helper and adds the card-row pointer-equality
    // check; eligibility now imports the charge-ready variant.
    expect(HELPER).toMatch(
      /import \{ getChargeReadyCardAuthorizationStatus \} from "@\/lib\/consent\/current-card-authorization"/,
    );
    expect(HELPER).toMatch(
      /getChargeReadyCardAuthorizationStatus\(\{[\s\S]{0,100}studioId/,
    );
  });

  it("dispatches on all four card-auth kinds with distinct messages", () => {
    const kinds = HELPER.match(
      /case "no_live_template"[\s\S]*?break;[\s\S]*?case "unsigned"[\s\S]*?break;[\s\S]*?case "signed_out_of_date"[\s\S]*?break;[\s\S]*?case "signed_current"[\s\S]*?break;/,
    );
    expect(kinds).not.toBeNull();
    // No two cases share a message string.
    expect(HELPER).toMatch(/Card authorization template is not configured/);
    expect(HELPER).toMatch(/Card authorization is not signed/);
    expect(HELPER).toMatch(/Card authorization on file is out of date/);
  });
});

describe("getSessionPaymentEligibility: studio Stripe settings", () => {
  it("reads studio_payment_settings scoped by studio_id", () => {
    expect(HELPER).toMatch(
      /\.from\("studio_payment_settings"\)[\s\S]{0,400}\.eq\("studio_id",\s*args\.studioId\)/,
    );
  });

  it("requires stripe_livemode === false (test-mode v1 rule)", () => {
    expect(HELPER).toMatch(/settings\.stripe_livemode !== false/);
    expect(HELPER).toMatch(/Live mode is not supported in v1/);
  });

  it("requires stripe_account_status === 'enabled'", () => {
    expect(HELPER).toMatch(/settings\.stripe_account_status !== "enabled"/);
  });
});

describe("getSessionPaymentEligibility: duplicate attempt check", () => {
  it("reads payment_charge_attempts scoped by studio + session + reason", () => {
    expect(HELPER).toMatch(
      // SELECT body widened by PR #175 (receipt_*) and PR #178
      // (refund_*); the window between .from and the first .eq
      // grows when more columns are added. Keep the structural
      // anchors but widen the slack.
      /\.from\("payment_charge_attempts"\)[\s\S]{0,1500}\.eq\("studio_id",\s*args\.studioId\)[\s\S]{0,400}\.eq\("session_id",\s*sessionSummary\.id\)[\s\S]{0,400}\.eq\("charge_reason",\s*"session_payment"\)/,
    );
  });

  it("the active-status set matches the partial unique index from migration 0073", () => {
    // payment_charge_attempts_active_session_payment_uniq:
    //   status in ('ready', 'pending_stripe', 'succeeded')
    expect(HELPER).toMatch(
      /blockingStatuses[\s\S]{0,200}"ready"[\s\S]{0,40}"pending_stripe"[\s\S]{0,40}"succeeded"/,
    );
  });

  it("blocks with a duplicate-message when an active attempt exists", () => {
    expect(HELPER).toMatch(
      /A session payment attempt is already prepared for this session/,
    );
  });
});

describe("session-payment-types: constants and shape", () => {
  it("amount ceiling is 200_000 cents ($2,000 CAD), matching the table CHECK", () => {
    expect(TYPES).toMatch(/SESSION_PAYMENT_AMOUNT_CEILING_CENTS = 200_000/);
  });

  it("internal note ceiling is 1000 characters", () => {
    expect(TYPES).toMatch(/SESSION_PAYMENT_INTERNAL_NOTE_MAX_LENGTH = 1000/);
  });

  it("the eligibility result is a discriminated union on `eligible`", () => {
    expect(TYPES).toMatch(/eligible: true;/);
    expect(TYPES).toMatch(/eligible: false;/);
    expect(TYPES).toMatch(/blockingReasons: string\[\]/);
  });

  it("the eligible branch carries Stripe lineage stamped on the row", () => {
    expect(TYPES).toMatch(/stripeAccountId: string/);
    expect(TYPES).toMatch(/stripeCustomerId: string/);
    expect(TYPES).toMatch(/stripePaymentMethodId: string/);
  });
});
