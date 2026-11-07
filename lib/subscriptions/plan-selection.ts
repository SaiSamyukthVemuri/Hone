// Plan selection for the public pricing cards (HON-70).
//
// With the flag OFF (the default) there is no plan-selection entry point at
// all: callers keep the guided-onboarding CTA exactly as it is today. With the
// flag ON each plan gets a link into the account step, carrying only the plan
// KEY. A price id is never put in a URL and never read from one.

import {
  PLANS,
  PLAN_KEYS,
  isSelfServeCheckoutEnabled,
  parsePlanKey,
  type PlanKey,
  type SubscriptionEnv,
} from "./plans";

export const SIGNUP_PATH = "/signup";

export interface PlanChoice {
  readonly plan: PlanKey;
  readonly label: string;
  readonly href: string;
}

/** The plan-selection CTAs, or an empty list while the flag is off. */
export function getPlanChoices(env: SubscriptionEnv): readonly PlanChoice[] {
  if (!isSelfServeCheckoutEnabled(env)) return [];
  return PLAN_KEYS.map((plan) => ({
    plan,
    label: `Choose ${PLANS[plan].label}`,
    href: `${SIGNUP_PATH}?plan=${plan}`,
  }));
}

/** Resolve the `?plan=` query value on the signup route. */
export function selectedPlanFromQuery(
  value: string | string[] | undefined,
): PlanKey | null {
  return parsePlanKey(Array.isArray(value) ? value[0] : value);
}
