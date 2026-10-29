import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateSetup, SUPPORTED_JURISDICTIONS, validateProposal, type SetupInput } from "@/lib/billing/jurisdiction-setup";

const base = (over: Partial<SetupInput> = {}): SetupInput => ({
  entered: { payment_country: "US", payment_currency: "usd" },
  hasConnectedAccount: true,
  observedAccountCountry: "US",
  conflictingAccountCountry: null,
  statedCurrencies: [],
  ...over,
});

describe("validateProposal: explicit values, supported pairs only", () => {
  it("lists exactly the two pairs 0214 admits", () => {
    expect(SUPPORTED_JURISDICTIONS).toEqual([
      { country: "CA", currency: "cad" }, { country: "US", currency: "usd" },
    ]);
  });
  it.each([["CA", "cad"], ["US", "usd"]])("%s/%s is accepted", (country, currency) => {
    expect(validateProposal({ country, currency })).toMatchObject({ ok: true });
  });
  it.each([
    [{ country: "CA", currency: "usd" }, "unsupported_combination"],
    [{ country: "US", currency: "cad" }, "unsupported_combination"],
    [{ country: "GB", currency: "gbp" }, "unsupported_combination"],
    [{ country: "us", currency: "usd" }, "unsupported_combination"],
    [{ currency: "usd" }, "missing_country"],
    [{ country: "", currency: "usd" }, "missing_country"],
    [{ country: "CA" }, "missing_currency"],
    [{ country: "US", currency: null }, "missing_currency"],
  ])("%j is refused as %s; a country alone never selects a currency", (input, reason) => {
    expect(validateProposal(input)).toEqual({ ok: false, reason });
  });
});

describe("evaluateSetup: payments stay blocked until all three facts agree", () => {
  it("ready only when confirmed, observed and consistent", () => {
    expect(evaluateSetup(base())).toMatchObject({ state: "ready", meetsNewSetupStandard: true });
    expect(evaluateSetup(base({ statedCurrencies: ["usd", null] }))).toMatchObject({ state: "ready" });
  });
  it.each([null, { payment_country: "US", payment_currency: "cad" }, { payment_country: "US" }])(
    "entered %j needs owner confirmation (never a default)", (entered) => {
      expect(evaluateSetup(base({ entered }))).toMatchObject({ state: "needs_owner_confirmation", meetsNewSetupStandard: false });
    });
  it("confirmed but no account yet", () => {
    expect(evaluateSetup(base({ hasConnectedAccount: false }))).toMatchObject({ state: "awaiting_stripe_account", meetsNewSetupStandard: false });
  });
  it.each([null, undefined, ""])("unobserved country %j is blocked, even for Canada (no legacy allowance)", (observed) => {
    for (const [c, cur] of [["US", "usd"], ["CA", "cad"]]) {
      expect(evaluateSetup(base({ entered: { payment_country: c, payment_currency: cur }, observedAccountCountry: observed })))
        .toMatchObject({ state: "awaiting_stripe_country", meetsNewSetupStandard: false });
    }
  });
  it("a different observed country is a mismatch, not a correction of the entered value", () => {
    expect(evaluateSetup(base({ observedAccountCountry: "CA" }))).toMatchObject({ state: "country_mismatch", meetsNewSetupStandard: false });
  });
  it("a persisted conflict blocks even when the observation matches", () => {
    expect(evaluateSetup(base({ conflictingAccountCountry: "CA" }))).toMatchObject({ state: "country_conflict", meetsNewSetupStandard: false });
  });
  it("a price or money currency that disagrees with the entered currency blocks", () => {
    expect(evaluateSetup(base({ statedCurrencies: ["usd", "cad"] }))).toMatchObject({ state: "price_currency_mismatch", meetsNewSetupStandard: false });
  });
  it("the account country never decides the currency: US account + entered cad pair is refused upstream", () => {
    expect(evaluateSetup(base({ entered: { payment_country: "US", payment_currency: "cad" } }))).toMatchObject({ state: "needs_owner_confirmation" });
  });
  it("every blocked state explains the correction and carries no raw code", () => {
    const states = [
      base({ entered: null }), base({ hasConnectedAccount: false }), base({ observedAccountCountry: null }),
      base({ observedAccountCountry: "CA" }), base({ conflictingAccountCountry: "CA" }), base({ statedCurrencies: ["cad"] }),
    ].map(evaluateSetup);
    expect(new Set(states.map((s) => s.state)).size).toBe(6);
    for (const s of states) expect(s.explanation).toMatch(/^[A-Z].*\.$/);
  });
});

describe("NEGATIVE CONTROL and source guard", () => {
  it("PEER C2: the ready text claims only what was compared", () => {
    // no price currency is read: only the country was compared with Stripe
    const noCurrencies = evaluateSetup(base());
    expect(noCurrencies.state).toBe("ready");
    expect(noCurrencies.explanation).toMatch(/country/i);
    expect(noCurrencies.explanation).not.toMatch(/match[^.]*currenc/i);
    expect(noCurrencies.explanation).toMatch(/not checked/i);
    // only nulls were stated: still nothing compared
    expect(evaluateSetup(base({ statedCurrencies: [null] })).explanation).toMatch(/not checked/i);
    // a stated currency that agrees WAS compared, so the text may say so
    const compared = evaluateSetup(base({ statedCurrencies: ["usd"] }));
    expect(compared.explanation).toMatch(/currenc/i);
    expect(compared.explanation).not.toMatch(/not checked/i);
  });

  it("a rule that trusted the account country alone would call a mismatched price currency ready", () => {
    const naive = (i: SetupInput) => i.observedAccountCountry === "US";
    const input = base({ statedCurrencies: ["cad"] });
    expect(naive(input)).toBe(true);
    expect(evaluateSetup(input).meetsNewSetupStandard).toBe(false);
  });
  it("the module infers nothing from timezone, IP or locale and writes nothing", () => {
    const src = readFileSync("lib/billing/jurisdiction-setup.ts", "utf8")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(src).not.toMatch(/timeZone|Intl\.|navigator|locale|x-forwarded|geoip|headers\(/i);
    expect(src).not.toMatch(/\.rpc\(|\.insert\(|\.update\(|createAdminClient/);
  });
});

describe("Codex P2: the advisory check never claims payments are off", () => {
  it("no explanation and no panel text says payments are off or disabled", () => {
    const src = readFileSync("lib/billing/jurisdiction-setup.ts", "utf8");
    const panel = readFileSync("app/(app)/settings/payments/JurisdictionStatusPanel.tsx", "utf8");
    const claim = /payments?\s+(stay|stays|are|is|remain|remains)\s+(off|disabled|blocked)|cannot charge|stay off/i;
    expect(src).not.toMatch(claim);
    expect(panel).not.toMatch(claim);
    expect(panel).not.toMatch(/stay off/i);
  });
});

describe("Insurance finding 4: a legacy Canadian studio that still charges is never told payments are off", () => {
  it("a CA studio with a connected account and no observed country: rendered text has no off/disabled wording, and the verdict is unchanged", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { JurisdictionStatusPanel } = await import("@/app/(app)/settings/payments/JurisdictionStatusPanel");
    const verdict = evaluateSetup(base({ entered: { payment_country: "CA", payment_currency: "cad" }, observedAccountCountry: null }));
    expect(verdict.state).toBe("awaiting_stripe_country");
    expect(verdict.meetsNewSetupStandard).toBe(false);
    for (const v of [verdict, null]) {
      const html = renderToStaticMarkup(createElement(JurisdictionStatusPanel, { verdict: v }));
      expect(html).not.toMatch(/stay off|stays off|disabled|cannot charge|payments? (is|are) off/i);
    }
  });
});
