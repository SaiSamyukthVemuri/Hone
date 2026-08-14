import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// CARD-ON-FILE PERSISTENCE TRUTH: structural contracts.
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

// Executable source only: the headers deliberately DESCRIBE the removed
// patterns, so a raw-text assertion would fail on its own documentation.
const exec = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");

const FORM_EXEC = exec(FORM);
const WEBHOOK_EXEC = exec(WEBHOOK);

describe("Stripe acceptance is not Hone persistence, the client cannot claim otherwise", () => {
  it("never reaches a saved state directly from confirmSetup", () => {
    // The defect: `setDone(true)` fired the instant confirmSetup resolved, so
    // the portal said "Card saved" while Hone held no row at all.
    expect(FORM_EXEC).not.toMatch(/setDone\(true\)/);
    // Anchor on the actual CALL, not the word, a type-union member carries an
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
    // The confirmation read is injected into the shared state machine; the
    // component never decides "saved" from anything else.
    expect(FORM_EXEC).toMatch(/confirm: confirmCardPersistedAction/);
    expect(FORM_EXEC).toMatch(/setupIntentId,/);
    expect(FORM_EXEC).toMatch(/outcome === "saved"[\s\S]{0,160}setPhase\("saved"\)/);
    expect(FORM_EXEC).toMatch(/phase === "saved"[\s\S]{0,200}copy\.successHeadline/);
  });

  it("bounds the confirmation poll: no infinite waiting", () => {
    // OWNERSHIP MOVED: the bounds now live with the state machine so they can be
    // behaviourally exercised (tests/lib/payments/card-finalization.test.ts).
    const LIB = root("lib/payments/card-finalization.ts");
    const attempts = Number(LIB.match(/CONFIRM_MAX_ATTEMPTS\s*=\s*(\d+)/)?.[1]);
    const interval = Number(LIB.match(/CONFIRM_POLL_INTERVAL_MS\s*=\s*(\d+)/)?.[1]);
    const deadline = Number(LIB.match(/CONFIRM_DEADLINE_MS\s*=\s*([\d_]+)/)?.[1].replace(/_/g, ""));
    expect(attempts).toBeGreaterThan(0);
    expect(interval).toBeGreaterThan(0);
    // The wall-clock deadline is the real ceiling, and it is finite.
    expect(deadline).toBeGreaterThan(0);
    expect(deadline).toBeLessThanOrEqual(60_000);
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

describe("finalization is recoverable, not a dead end", () => {
  it("offers a Check-status-again action that re-reads the SAME SetupIntent", () => {
    expect(FORM_EXEC).toMatch(/onCheckAgain/);
    expect(FORM_EXEC).toMatch(/Check status again/);
    const fn = FORM_EXEC.slice(FORM_EXEC.indexOf("async function onCheckAgain"));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // It may only re-poll. It must never mint a SetupIntent or re-confirm.
    expect(body).toMatch(/pollForPersistence\(/);
    expect(body).not.toMatch(/createCardSetupIntentAction/);
    expect(body).not.toMatch(/confirmSetup/);
  });

  it("the not-confirmed state renders the recovery button, not a dead message", () => {
    expect(FORM_EXEC).toMatch(/phase === "notConfirmed" \|\| phase === "rechecking"/);
    expect(FORM_EXEC).toMatch(/onClick=\{onCheckAgain\}/);
  });

  it("does not promise a page that will not update itself", () => {
    // The old copy said the card "will appear on this page shortly" while
    // nothing was polling any more.
    expect(FORM).not.toMatch(/will appear on this page shortly/);
    expect(FORM).toMatch(/check status again below/i);
  });

  it("bounds the wait on wall clock AND per attempt, not just attempt count", () => {
    const LIB = root("lib/payments/card-finalization.ts");
    expect(LIB).toMatch(/CONFIRM_DEADLINE_MS/);
    expect(LIB).toMatch(/CONFIRM_ATTEMPT_TIMEOUT_MS/);
    expect(LIB).toMatch(/CONFIRM_MAX_ATTEMPTS/);
    // The state machine issues no Stripe call of any kind, a confirmation
    // timeout can therefore never submit another card. Asserted on executable
    // source: the header mentions js.stripe.com when explaining why Elements
    // cannot be driven in the e2e lane.
    const LIB_EXEC = exec(LIB);
    expect(LIB_EXEC).not.toMatch(/confirmSetup|createCardSetupIntent|stripe\./);
  });
});

describe("setup_intent.succeeded: terminal rejection is never silent", () => {
  it("has no bare `rejected` return left in the handler", () => {
    // Every one of the eight rejection branches used to return a summary that
    // the parent then marked processed, with no alert of any kind.
    expect(WEBHOOK_EXEC).not.toMatch(/rejected:\s*"[a-z_]+",/);
  });

  it("the portal reads rejection from DURABLE stripe_events, never ops_alerts", () => {
    const ACTIONS_FN = ACTIONS.slice(
      ACTIONS.indexOf("export async function confirmCardPersistedAction"),
    );
    expect(ACTIONS_FN).toMatch(/\.from\("stripe_events"\)/);
    expect(ACTIONS_FN).toMatch(/payload_summary->>terminalRejection/);
    expect(ACTIONS_FN).toMatch(/\.not\("processed_at", "is", null\)/);
    // ops_alerts is a notification channel, not the state authority.
    expect(ACTIONS_FN).not.toMatch(/\.from\("ops_alerts"\)/);
    // Fail closed: unattributable rejections fall through to pending.
    expect(ACTIONS_FN).toMatch(/continue;/);
    // No internal reason reaches the browser.
    expect(ACTIONS_FN).not.toMatch(/state: "rejected", reason/);
  });

  // -------------------------------------------------------------------------
  // The ownership binding, pinned to the ownership QUERY specifically.
  //
  // The previous version of this guard asserted `.eq("client_id",
  // session.clientId)` against the whole function slice, and that slice runs
  // to end of file and contains TWO client-bound queries
  // (client_payment_methods and client_stripe_customers). Deleting the binding
  // from the OWNERSHIP query left the other one matching, so the guard passed
  // while same-studio cross-client probing was reopened. A negative control is
  // what exposed it; the guard now extracts the one query expression it is
  // talking about before asserting anything.
  // -------------------------------------------------------------------------

  /**
   * The single chained PostgREST expression that starts at `.from(table)` and
   * ends at its own terminator. Bounded and single-query by construction: it
   * fails loudly rather than silently swallowing a neighbouring query if the
   * implementation is restructured.
   */
  function queryExpression(src: string, table: string, terminator: string): string {
    const start = src.indexOf(`.from("${table}")`);
    expect(start, `no .from("${table}") in the action`).toBeGreaterThan(-1);
    const end = src.indexOf(terminator, start);
    expect(end, `no ${terminator} after .from("${table}")`).toBeGreaterThan(start);
    const expr = src.slice(start, end + terminator.length);
    // Exactly ONE query in the slice, if a restructure moved the terminator,
    // this catches it instead of the assertions below passing on a neighbour.
    expect(
      (expr.match(/\.from\(/g) ?? []).length,
      `the extracted ${table} expression swallowed another query`,
    ).toBe(1);
    expect(expr.length, `${table} expression implausibly long`).toBeLessThan(600);
    return expr;
  }

  it("the OWNERSHIP query itself is bound to studio, client, account, mode and customer", () => {
    const ACTIONS_FN = ACTIONS.slice(
      ACTIONS.indexOf("export async function confirmCardPersistedAction"),
    );
    const ownership = queryExpression(
      ACTIONS_FN,
      "client_stripe_customers",
      ".maybeSingle()",
    );
    // All five predicates must live on THIS query. A matching predicate on any
    // other query in the function cannot satisfy these.
    expect(ownership).toMatch(/\.eq\("studio_id", session\.studioId\)/);
    expect(ownership).toMatch(/\.eq\("client_id", session\.clientId\)/);
    expect(ownership).toMatch(/\.eq\("stripe_account_id", accountId\)/);
    expect(ownership).toMatch(/\.eq\("stripe_livemode", livemode\)/);
    expect(ownership).toMatch(/\.eq\("stripe_customer_id", customerId\)/);
  });

  it("the guard cannot be satisfied by the OTHER client-bound query", () => {
    // Proves the extraction is doing real work: the card lookup is also
    // client-bound, and it must NOT be what the ownership assertions read.
    const ACTIONS_FN = ACTIONS.slice(
      ACTIONS.indexOf("export async function confirmCardPersistedAction"),
    );
    const card = queryExpression(
      ACTIONS_FN,
      "client_payment_methods",
      ".maybeSingle()",
    );
    const ownership = queryExpression(
      ACTIONS_FN,
      "client_stripe_customers",
      ".maybeSingle()",
    );
    expect(card).not.toBe(ownership);
    // Both are client-bound: which is exactly why a whole-function regex was
    // ambiguous, but only the ownership one carries the Stripe lineage.
    expect(card).toMatch(/\.eq\("client_id", session\.clientId\)/);
    expect(card).not.toMatch(/stripe_customer_id/);
    expect(ownership).toMatch(/stripe_customer_id/);
  });

  it("terminal rejection is returned ONLY behind the proved-ownership gate", () => {
    const ACTIONS_FN = ACTIONS.slice(
      ACTIONS.indexOf("export async function confirmCardPersistedAction"),
    );
    // The only `rejected` return in the function is the one guarded by `owner`,
    // the ownership query's own result. An unguarded return would be a
    // cross-client oracle.
    const rejectedReturns = [
      ...ACTIONS_FN.matchAll(/(.{0,80})return \{ ok: true, state: "rejected" \}/g),
    ];
    expect(rejectedReturns.length).toBe(1);
    expect(rejectedReturns[0][1]).toMatch(/if \(owner\)\s*$/);
  });

  it("the webhook records the ownership anchor the portal binds against", () => {
    const helper = WEBHOOK.slice(WEBHOOK.indexOf("async function terminalCardRejection"));
    expect(helper).toMatch(/stripeCustomerId/);
    expect(helper).toMatch(/stripeAccountId: ctx\.stripeAccountId/);
    expect(helper).toMatch(/stripeLivemode: ctx\.livemode/);
  });

  it("does not claim every terminal rejection is portal-visible", () => {
    // The fail-closed design deliberately leaves unbindable rejections as
    // not-confirmed for the client while remaining fully operator-visible.
    expect(ACTIONS).toMatch(/If ownership cannot be proved, the answer is `pending`/);
  });

  it("names the ops-alert guarantee honestly in the event summary", () => {
    // recordOpsAlert's DB insert is best-effort, so the summary must not claim
    // a durable row exists.
    expect(WEBHOOK).not.toMatch(/opsAlerted: true/);
    expect(WEBHOOK).toMatch(/opsAlertAttempted: true/);
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
