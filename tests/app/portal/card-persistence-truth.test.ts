import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CARD-ON-FILE PERSISTENCE TRUTH — structural contracts.
//
// The behaviour of the atomic command is proved against a real database in
// tests/db/card-replacement-atomicity.db.test.ts. This file pins the things a
// behavioural test cannot see: that certain code paths NO LONGER EXIST.
// "This branch is absent" is necessarily a static property, which is why it is
// asserted here rather than exercised.

const root = (p: string) => readFileSync(join(__dirname, "..", "..", "..", p), "utf8");

const FORM = root("app/portal/PortalPaymentMethodForm.tsx");
const ACTIONS = root("app/portal/payment-method-actions.ts");
const WEBHOOK = root("app/api/stripe/webhook/route.ts");

// Executable source only — the headers deliberately DESCRIBE the removed
// patterns, so a raw-text assertion would fail on its own documentation.
const exec = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

const FORM_EXEC = exec(FORM);
const WEBHOOK_EXEC = exec(WEBHOOK);

describe("Stripe acceptance is not Hone persistence — the client cannot claim otherwise", () => {
  it("never reaches a saved state directly from confirmSetup", () => {
    // The defect: `setDone(true)` fired the instant confirmSetup resolved, so
    // the portal said "Card saved" while Hone held no row at all.
    expect(FORM_EXEC).not.toMatch(/setDone\(true\)/);
    // Anchor on the actual CALL, not the word — a type-union member carries an
    // inline "confirmSetup in flight" comment earlier in the file.
    const call = FORM_EXEC.indexOf("stripe.confirmSetup(");
    expect(call).toBeGreaterThan(-1);
    const afterConfirm = FORM_EXEC.slice(call);
    const phases = [...afterConfirm.matchAll(/setPhase\("(\w+)"\)/g)].map((m) => m[1]);
    expect(phases.length).toBeGreaterThan(0);
    // "saved" must never be the first thing set after Stripe returns, and it
    // must be preceded by the intermediate finalizing state.
    expect(phases[0]).not.toBe("saved");
    expect(phases.indexOf("finalizing")).toBeGreaterThan(-1);
    expect(phases.indexOf("finalizing")).toBeLessThan(phases.indexOf("saved"));
  });

  it("only shows the saved headline after Hone confirms its own record", () => {
    expect(FORM_EXEC).toMatch(/confirmCardPersistedAction\(setupIntentId\)/);
    // saved is reachable only from a "saved" response.
    expect(FORM_EXEC).toMatch(/res\.state === "saved"[\s\S]{0,120}setPhase\("saved"\)/);
    expect(FORM_EXEC).toMatch(/phase === "saved"[\s\S]{0,200}copy\.successHeadline/);
  });

  it("bounds the confirmation poll — no infinite waiting", () => {
    expect(FORM).toMatch(/CONFIRM_POLL_ATTEMPTS\s*=\s*\d+/);
    expect(FORM).toMatch(/CONFIRM_POLL_INTERVAL_MS\s*=\s*\d+/);
    const attempts = Number(FORM.match(/CONFIRM_POLL_ATTEMPTS\s*=\s*(\d+)/)?.[1]);
    const interval = Number(FORM.match(/CONFIRM_POLL_INTERVAL_MS\s*=\s*(\d+)/)?.[1]);
    expect(attempts).toBeGreaterThan(0);
    expect(attempts * interval).toBeLessThanOrEqual(30_000);
  });

  it("has three distinct terminal states, and none of them tells the client to re-enter the card", () => {
    for (const k of ["successHeadline", "stillFinalizingHeadline", "rejectedHeadline"]) {
      expect(FORM).toContain(k);
    }
    // Stripe may already hold the card; telling the user to resubmit risks a
    // duplicate SetupIntent and a second charge path.
    const headlines = [...FORM.matchAll(/(stillFinalizing|rejected)Headline:\s*\n?\s*"([^"]+)"/g)].map(
      (m) => m[2],
    );
    expect(headlines.length).toBeGreaterThanOrEqual(2);
    for (const h of headlines) {
      expect(h.toLowerCase()).toContain("do not");
    }
  });

  it("exposes the SetupIntent id so the browser can ask Hone about its own record", () => {
    expect(ACTIONS).toMatch(/setupIntentId: setup\.setupIntentId/);
    expect(ACTIONS).toMatch(/export async function confirmCardPersistedAction/);
    // The confirmation must be scoped to the caller's own portal session.
    const fn = ACTIONS.slice(ACTIONS.indexOf("export async function confirmCardPersistedAction"));
    expect(fn).toMatch(/getCurrentPortalSession/);
    expect(fn).toMatch(/session\.studioId/);
    expect(fn).toMatch(/session\.clientId/);
    expect(fn).toMatch(/\.eq\("status", "active"\)/);
  });
});

describe("setup_intent.succeeded — terminal rejection is never silent", () => {
  it("has no bare `rejected` return left in the handler", () => {
    // Every one of the eight rejection branches used to return a summary that
    // the parent then marked processed, with no alert of any kind.
    expect(WEBHOOK_EXEC).not.toMatch(/rejected:\s*"[a-z_]+",/);
  });

  it("routes every rejection through the alerting helper", () => {
    const calls = WEBHOOK_EXEC.match(/terminalCardRejection\(/g) ?? [];
    // 8 original branches + the command's own lineage refusal + the definition.
    expect(calls.length).toBeGreaterThanOrEqual(9);
    const helper = WEBHOOK.slice(WEBHOOK.indexOf("async function terminalCardRejection"));
    expect(helper).toMatch(/await recordOpsAlert\(/);
    expect(helper).toMatch(/card_on_file_setup_rejected/);
    expect(helper).toMatch(/severity: "critical"/);
    expect(helper).toMatch(/terminalRejection: true/);
  });
});

describe("card replacement is one transaction", () => {
  it("the webhook no longer performs the two-write retire-then-insert", () => {
    // The retire and the insert were separate PostgREST round trips, each its
    // own transaction. Neither may return.
    expect(WEBHOOK_EXEC).not.toMatch(/status:\s*"removed"/);
    expect(WEBHOOK_EXEC).not.toMatch(/\.from\("client_payment_methods"\)\s*\n?\s*\.insert\(/);
  });

  it("persists through the 0180 governed command instead", () => {
    expect(WEBHOOK_EXEC).toMatch(/admin\.rpc\(\s*\n?\s*"save_client_card_on_file"/);
    expect(WEBHOOK_EXEC).toMatch(/save_client_card_on_file_failed/);
    // A lineage refusal from the command is terminal but still alerted.
    expect(WEBHOOK_EXEC).toMatch(/saveErr\.code === "22023"/);
  });
});
