import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #173. Source-grep tests for the new executeSessionPaymentChargeAction
// + the UI wiring. The action is the server-action entry point for
// the prepare-card's "Run charge" button; it must:
//   * resolve practitioner + studio from the session
//   * require an explicit confirm_charge='true' flag
//   * never accept browser-supplied amount / card id / client id /
//     session id beyond optional revalidatePath context
//   * delegate the work to runSessionPaymentCharge

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
);
const ACTION = readFileSync(ACTION_PATH, "utf8");

const CARD_PATH = path.resolve(
  __dirname,
  "../../../components/session-payment-prepare-card.tsx",
);
const CARD = readFileSync(CARD_PATH, "utf8");

const PAGE_PATH = path.resolve(
  __dirname,
  "../../../app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
);
const PAGE = readFileSync(PAGE_PATH, "utf8");

describe("execute action: auth + confirm gate", () => {
  it("resolves practitioner + studio via getCurrentPractitionerWithStudio", () => {
    expect(ACTION).toMatch(/getCurrentPractitionerWithStudio/);
  });

  it("requires an explicit confirm_charge='true' form flag", () => {
    // The action reads `confirm_charge` from the form into a
    // `confirmCharge` variable (camelCase) and refuses if it
    // is not the literal string "true".
    expect(ACTION).toMatch(/formData\.get\("confirm_charge"\)/);
    expect(ACTION).toMatch(/confirmCharge !== "true"/);
    expect(ACTION).toMatch(/Confirm the test charge before running it/);
  });

  it("does NOT accept amount / card_id / practitioner_id from the form", () => {
    // The execute action reads only the attempt_id (plus optional
    // revalidatePath context). A browser-supplied amount or card
    // id would be a privilege escalation.
    const block =
      ACTION.match(
        /executeSessionPaymentChargeAction[\s\S]*?\n\}/,
      )?.[0] ?? "";
    expect(block).not.toMatch(/formData\.get\("amount/);
    expect(block).not.toMatch(/formData\.get\("client_payment_method/);
    expect(block).not.toMatch(/formData\.get\("practitioner_id"\)/);
    expect(block).not.toMatch(/formData\.get\("studio_id"\)/);
  });
});

describe("execute action: delegation", () => {
  it("imports runSessionPaymentCharge from lib/billing/session-payment-charge", () => {
    expect(ACTION).toMatch(
      /import\s*\{\s*\n?\s*runSessionPaymentCharge,[\s\S]{0,200}\}\s*from\s*"@\/lib\/billing\/session-payment-charge"/,
    );
  });

  it("forwards (attemptId, studioId, practitionerId) to runSessionPaymentCharge", () => {
    expect(ACTION).toMatch(
      /runSessionPaymentCharge\(\{\s*\n?\s*attemptId,\s*\n?\s*studioId,\s*\n?\s*practitionerId,\s*\n?\s*\}\)/,
    );
  });

  it("revalidates the session detail path on terminal result", () => {
    expect(ACTION).toMatch(
      /revalidatePath\(`\/clients\/\$\{clientId\}\/sessions\/\$\{sessionId\}`\)/,
    );
  });
});

describe("execute action: typed result outcomes", () => {
  it("declares all eight outcome literals", () => {
    const required = [
      '"failed"',
      '"needs_manual_review"',
      '"blocked"',
      '"live_mode_blocked"',
      '"lineage_mismatch"',
      '"authorization_not_current"',
      '"not_found"',
      '"not_authorized"',
    ];
    for (const tok of required) {
      expect(ACTION).toContain(tok);
    }
  });

  it("declares the succeeded outcome with PaymentIntent + Charge ids", () => {
    expect(ACTION).toMatch(/outcome:\s*"succeeded"/);
    expect(ACTION).toMatch(/stripePaymentIntentId:\s*string/);
    expect(ACTION).toMatch(/stripeChargeId:\s*string \| null/);
  });
});

describe("execute action: no forbidden behavior", () => {
  it("does NOT call any Stripe method directly (delegates to runSessionPaymentCharge)", () => {
    expect(ACTION).not.toMatch(/paymentIntents\.create/);
    expect(ACTION).not.toMatch(/paymentIntents\.retrieve/);
    expect(ACTION).not.toMatch(/charges\.create/);
    expect(ACTION).not.toMatch(/refunds\.create/);
  });

  it("does NOT touch manual_fee_charge_attempts", () => {
    expect(ACTION).not.toMatch(/manual_fee_charge_attempts/);
  });

  it("does NOT relax STRIPE_ALLOW_LIVE_MODE", () => {
    expect(ACTION).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
  });

  it("does NOT import any SMS or email helper", () => {
    expect(ACTION).not.toMatch(/lib\/sms\//);
    expect(ACTION).not.toMatch(/lib\/email\//);
  });
});

describe("SessionPaymentPrepareCard: Run charge button (PR #173)", () => {
  it("accepts an executeAction prop", () => {
    expect(CARD).toMatch(/executeAction:\s*ExecuteAction/);
  });

  it("only renders the button when the active attempt status is 'ready' (PR #174 via ReadyPanel)", () => {
    // PR #174 moved the Run charge button into a dedicated
    // ReadyPanel subcomponent. AttemptStatusPanel dispatches on
    // attempt.status; only the 'ready' case returns ReadyPanel,
    // which is the only place the executeAction is consumed.
    expect(CARD).toMatch(/case "ready":\s*\n?\s*return \(\s*\n?\s*<ReadyPanel/);
    expect(CARD).toMatch(
      /function ReadyPanel\([\s\S]{0,400}executeAction: ExecuteAction/,
    );
    expect(CARD).toMatch(/executeAction=\{executeAction\}/);
  });

  it("the run-charge panel uses the neutral Stripe-charge caution (no test-mode claim)", () => {
    expect(CARD).toMatch(/Stripe charge/);
    expect(CARD).toMatch(/Run charge/);
    // Neutralized: no false-in-live "test mode" / "no live card" claim.
    expect(CARD).not.toMatch(/Stripe test mode/);
    expect(CARD).not.toMatch(/No live card is charged/);
  });

  it("the button does NOT say Pay now / Charge card / Collect payment", () => {
    // The file header documents what we are NOT building; strip
    // every single-line `//` comment before grepping so the
    // documentation does not trip the assertion.
    const codeOnly = CARD.split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n");
    expect(codeOnly).not.toMatch(/Pay now/);
    expect(codeOnly).not.toMatch(/Charge card/);
    expect(codeOnly).not.toMatch(/Collect payment/);
  });

  it("uses a two-click confirm pattern (first click flips confirmExecute, second submits)", () => {
    expect(CARD).toMatch(/if \(!confirmExecute\)/);
    expect(CARD).toMatch(/setConfirmExecute\(true\)/);
    expect(CARD).toMatch(/Confirm: run charge/);
  });

  it("submits confirm_charge='true' on the second click", () => {
    expect(CARD).toMatch(/fd\.set\("confirm_charge",\s*"true"\)/);
  });

  it("renders the succeeded panel with PaymentIntent + Charge ids", () => {
    expect(CARD).toMatch(/Charge succeeded/);
    expect(CARD).toMatch(/PaymentIntent:/);
  });

  it("notes that no receipt is sent in this PR", () => {
    expect(CARD).toMatch(/No receipt was\s*\n?\s*sent in this PR/);
  });

  it("does NOT import Stripe Elements", () => {
    expect(CARD).not.toMatch(/@stripe\/stripe-js/);
    expect(CARD).not.toMatch(/@stripe\/react-stripe-js/);
  });
});

describe("session detail page wires the executeAction", () => {
  it("imports executeSessionPaymentChargeAction", () => {
    expect(PAGE).toMatch(/executeSessionPaymentChargeAction/);
  });

  it("passes executeAction prop to SessionPaymentPrepareCard", () => {
    expect(PAGE).toMatch(/executeAction=\{executeSessionPaymentChargeAction\}/);
  });

  it("passes clientId prop to SessionPaymentPrepareCard", () => {
    expect(PAGE).toMatch(/<SessionPaymentPrepareCard[\s\S]{0,400}clientId=\{id\}/);
  });
});
