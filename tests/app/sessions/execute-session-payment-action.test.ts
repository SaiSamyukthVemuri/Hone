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
    // PR C: the confirmation error is mode-aware — a live operator is
    // never told a real charge is a "test charge".
    expect(ACTION).toMatch(/inferStripeLivemode\(\)\s*\n?\s*\? "Confirm the charge before running it\."\s*\n?\s*: "Confirm the test charge before running it\."/);
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
  it("forwards (attemptId, studioId, practitionerId) to runSessionPaymentCharge", () => {
    expect(ACTION).toMatch(
      /runSessionPaymentCharge\(\{\s*\n?\s*attemptId,\s*\n?\s*studioId,\s*\n?\s*practitionerId,\s*\n?\s*\}\)/,
    );
  });
});

describe("execute action: no forbidden behavior", () => {
  it("does NOT call any Stripe method directly (delegates to runSessionPaymentCharge)", () => {
    expect(ACTION).not.toMatch(/paymentIntents\.create/);
    expect(ACTION).not.toMatch(/paymentIntents\.retrieve/);
    expect(ACTION).not.toMatch(/charges\.create/);
    expect(ACTION).not.toMatch(/refunds\.create/);
  });
});

describe("SessionPaymentPrepareCard: Run charge button (PR #173)", () => {
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

  it("uses a two-click confirm pattern (first click flips confirmExecute, second submits)", () => {
    expect(CARD).toMatch(/if \(!confirmExecute\)/);
    expect(CARD).toMatch(/setConfirmExecute\(true\)/);
    expect(CARD).toMatch(/Confirm: run charge/);
  });

  it("does NOT import Stripe Elements", () => {
    expect(CARD).not.toMatch(/@stripe\/stripe-js/);
    expect(CARD).not.toMatch(/@stripe\/react-stripe-js/);
  });
});
