import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #177. Source-grep tests pin the wiring between
// signConsentFormAction and the refresh helper. The action must:
//   * call the refresh helper AFTER the signature insert succeeds
//   * gate the refresh call on template.form_type === 'card_authorization'
//   * pass the just-inserted signature id (created.id) as signatureId
//   * NOT roll back the signature on refresh failure
//   * NOT call any charge-ready gate (deadlock prevention)
//   * NOT call the base auth-status gate either (the action's role
//     is to record the signature, not to gate it on prior state)

const ACTION_PATH = path.resolve(
  __dirname,
  "../../../app/portal/consent-actions.ts",
);
const ACTION = readFileSync(ACTION_PATH, "utf8");

describe("signConsentFormAction: PR #177 refresh wiring", () => {
  it("imports the refresh helper", () => {
    expect(ACTION).toMatch(
      /import \{ refreshActiveCardAuthorizationPointersForSignature \} from "@\/lib\/payment-methods\/refresh-card-authorization-pointer"/,
    );
  });

  it("calls the refresh helper only when template.form_type === 'card_authorization'", () => {
    expect(ACTION).toMatch(
      /if \(result\.formType === "card_authorization"\)[\s\S]{0,1500}refreshActiveCardAuthorizationPointersForSignature\(/,
    );
  });

  it("passes the just-inserted signature id (created.id) as signatureId", () => {
    expect(ACTION).toMatch(
      /refreshActiveCardAuthorizationPointersForSignature\(\{[\s\S]{0,400}signatureId:\s*result\.signatureId[\s\S]{0,400}\}\)/,
    );
  });

  it("passes the same studioId + clientId the signature was scoped to", () => {
    expect(ACTION).toMatch(
      /refreshActiveCardAuthorizationPointersForSignature\(\{[\s\S]{0,400}studioId:\s*session\.studioId[\s\S]{0,400}clientId:\s*session\.clientId[\s\S]{0,400}\}\)/,
    );
  });
});

describe("signConsentFormAction: PR #177 fail-soft contract", () => {
  it("the refresh call happens AFTER the signature insert success guard", () => {
    // The insert error branch returns early; the refresh wiring sits
    // below the post-insert revalidate. We pin the order by checking
    // that the refresh-helper call site appears AFTER the insert
    // error check returns and BEFORE the final return ok:true.
    const insertErrIdx = ACTION.indexOf("if (!result.ok)");
    // The import statement also matches the substring; find the
    // call site instead by looking for the open-paren after the
    // helper name.
    const refreshIdx = ACTION.indexOf(
      "refreshActiveCardAuthorizationPointersForSignature({",
    );
    const finalReturnIdx = ACTION.lastIndexOf(
      "return { ok: true, signatureId: result.signatureId };",
    );
    expect(insertErrIdx).toBeGreaterThan(-1);
    expect(refreshIdx).toBeGreaterThan(insertErrIdx);
    expect(finalReturnIdx).toBeGreaterThan(refreshIdx);
  });

  it("does NOT throw on refresh failure; logs structured stderr line instead", () => {
    expect(ACTION).toMatch(
      /if \(!refresh\.ok\)[\s\S]{0,800}consent_sign_pointer_refresh_failed/,
    );
    // No `throw` between the refresh-failure log and the final return.
    const failBlock =
      ACTION.match(
        /if \(!refresh\.ok\)[\s\S]{0,1000}\n\s*\}\s*\n\s*\}/,
      )?.[0] ?? "";
    expect(failBlock).not.toMatch(/throw\s/);
  });

  it("returns ok:true even when refresh fails (the signature is durable)", () => {
    // The function's only ok:true return is below the refresh
    // wiring; pin that the wiring does NOT short-circuit the
    // happy-path return.
    const happyReturn = ACTION.match(
      /return \{ ok: true, signatureId: result\.signatureId \};/g,
    );
    expect((happyReturn ?? []).length).toBe(1);
  });
});

describe("signConsentFormAction: PR #177 deadlock prevention", () => {
  it("does NOT import any auth-status gate (base or charge-ready)", () => {
    expect(ACTION).not.toMatch(/import \{[^}]*getCardAuthorizationStatus/);
    expect(ACTION).not.toMatch(
      /import \{[^}]*getChargeReadyCardAuthorizationStatus/,
    );
  });

  it("does NOT gate the signature insert on any prior pointer state", () => {
    // The action's pre-insert checks are: portal session, client
    // archived, template lookup. None of those involve the card
    // row. Pin that no client_payment_methods read occurs anywhere
    // in the action.
    expect(ACTION).not.toMatch(/client_payment_methods/);
  });
});

describe("signConsentFormAction: PR #177 form_type gate (Add Card / non-card paths)", () => {
  it("non-card_authorization form_types skip the refresh path entirely", () => {
    // The if-gate around the refresh call means treatment_consent,
    // photo_consent, etc. never invoke the helper. The negative
    // assertion is: refresh helper call is ONLY inside the
    // form_type guard.
    const refreshCallCount =
      (ACTION.match(/refreshActiveCardAuthorizationPointersForSignature/g) ??
        [])
        .length;
    // Two occurrences expected: the import statement + the single
    // call site inside the if-block.
    expect(refreshCallCount).toBe(2);
  });
});
