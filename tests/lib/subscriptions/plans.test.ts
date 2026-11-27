import { describe, expect, it } from "vitest";
import {
  PLANS,
  isSelfServeCheckoutEnabled,
  parsePlanKey,
  planForPriceId,
  resolvePlanPriceId,
} from "@/lib/subscriptions/plans";
import {
  getPlanChoices,
  selectedPlanFromQuery,
} from "@/lib/subscriptions/plan-selection";
import { ENV_ON, SOLO_PRICE, STUDIO_PRICE } from "./helpers/fake-billing-client";

describe("plans", () => {
  it("fixes the HON-70 plan terms", () => {
    expect(PLANS.solo).toMatchObject({ unitAmount: 4900, practitionerLimit: 1 });
    expect(PLANS.studio).toMatchObject({ unitAmount: 9900, practitionerLimit: 3 });
    for (const p of Object.values(PLANS)) {
      expect(p.currency).toBe("usd");
      expect(p.interval).toBe("month");
    }
  });

  it("is off unless the flag is exactly the string true", () => {
    expect(isSelfServeCheckoutEnabled({})).toBe(false);
    for (const v of ["", "1", "TRUE", "True", " true", "true ", "yes", "false"]) {
      expect(isSelfServeCheckoutEnabled({ HONE_SELF_SERVE_CHECKOUT_ENABLED: v })).toBe(false);
    }
    expect(isSelfServeCheckoutEnabled(ENV_ON)).toBe(true);
  });

  it("parses only the two plan keys", () => {
    expect(parsePlanKey("solo")).toBe("solo");
    expect(parsePlanKey("studio")).toBe("studio");
    for (const v of ["Solo", "enterprise", "price_x", "", null, undefined, 1, {}]) {
      expect(parsePlanKey(v)).toBeNull();
    }
  });

  it("resolves price ids from env and rejects malformed or missing ones", () => {
    expect(resolvePlanPriceId("solo", ENV_ON)).toBe(SOLO_PRICE);
    expect(resolvePlanPriceId("studio", ENV_ON)).toBe(STUDIO_PRICE);
    expect(resolvePlanPriceId("solo", {})).toBeNull();
    expect(resolvePlanPriceId("solo", { HONE_STRIPE_PRICE_SOLO: "prod_123" })).toBeNull();
    expect(resolvePlanPriceId("solo", { HONE_STRIPE_PRICE_SOLO: "price_a b" })).toBeNull();
  });

  it("maps a price id back to its plan and refuses unknown prices", () => {
    expect(planForPriceId(SOLO_PRICE, ENV_ON)).toBe("solo");
    expect(planForPriceId(STUDIO_PRICE, ENV_ON)).toBe("studio");
    expect(planForPriceId("price_other", ENV_ON)).toBeNull();
    // An unset env must not make an empty/undefined-ish id match.
    expect(planForPriceId("", {})).toBeNull();
  });
});

describe("plan selection", () => {
  it("offers nothing while the flag is off", () => {
    expect(getPlanChoices({})).toEqual([]);
    expect(getPlanChoices({ HONE_SELF_SERVE_CHECKOUT_ENABLED: "false" })).toEqual([]);
  });

  it("offers Solo and Studio keyed by plan, never by price id, when on", () => {
    const choices = getPlanChoices(ENV_ON);
    expect(choices.map((c) => c.label)).toEqual(["Choose Solo", "Choose Studio"]);
    expect(choices.map((c) => c.href)).toEqual([
      "/signup?plan=solo",
      "/signup?plan=studio",
    ]);
    for (const c of choices) expect(c.href).not.toContain("price_");
  });

  it("reads the plan back from a query value", () => {
    expect(selectedPlanFromQuery("studio")).toBe("studio");
    expect(selectedPlanFromQuery(["solo", "studio"])).toBe("solo");
    expect(selectedPlanFromQuery("price_testSolo123")).toBeNull();
    expect(selectedPlanFromQuery(undefined)).toBeNull();
  });
});
