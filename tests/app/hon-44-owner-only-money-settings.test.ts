import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-44 / Sam decision 12: money is OWNER-ONLY. hon-44-owner-only-actions.test.ts
// proves the charge, receipt, settlement-record, quote, session-price and client-
// price actions. This file covers the money-adjacent actions that file does not:
//
//   * settlement waive and supersede (record is covered there);
//   * Stripe Connect: start onboarding, refresh status, open the dashboard;
//   * services (the price list): create, update, move, toggle active.
//
// Same method: run each action for real against a RECORDING stub for every
// database and Stripe entry point. A practitioner or receptionist-shaped role is
// refused with ZERO access of any kind, so a gate placed after a read fails here;
// the owner reaches the first access (positive control). The role is flipped per
// test and the action derives it from the authenticated practitioner alone.
// Synthetic data only. Current schema; the payment_charge_attempts read held on
// 0254 is not touched by anything here.

const state = vi.hoisted(() => ({ role: "practitioner" as string, touched: [] as string[] }));

function recorder(label: string): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined;
      state.touched.push(`${label}.${String(prop)}`);
      return proxy;
    },
    apply() {
      state.touched.push(`${label}()`);
      return proxy;
    },
  });
  return proxy;
}

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-2", role: state.role, active: true },
    studio: { id: "studio-1", timezone: "America/Toronto", slug: "synthetic" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    state.touched.push("createClient");
    return recorder("user");
  },
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    state.touched.push("createAdminClient");
    return recorder("admin");
  },
}));
vi.mock("@/lib/stripe/account", () => ({
  createOrLoadConnectedAccountForStudio: async () => {
    state.touched.push("stripe.createOrLoadConnectedAccountForStudio");
    throw new Error("stub: stop after the gate");
  },
  createOnboardingLink: async () => {
    state.touched.push("stripe.createOnboardingLink");
    throw new Error("stub");
  },
  refreshAccountStatusFromStripe: async () => {
    state.touched.push("stripe.refreshAccountStatusFromStripe");
    throw new Error("stub");
  },
  createLoginLink: async () => {
    state.touched.push("stripe.createLoginLink");
    throw new Error("stub");
  },
}));
vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getAppOrigin: () => "https://example.test",
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

import {
  waiveAppointmentFeeAction,
  supersedeAppointmentSettlementAction,
} from "@/app/(app)/appointment-settlement-actions";
import {
  startStripeConnectOnboardingAction,
  refreshStripeStatusAction,
  openStripeDashboardAction,
} from "@/app/(app)/settings/payments/actions";
import {
  createServiceAction,
  updateServiceAction,
  moveServiceAction,
  toggleServiceActiveAction,
} from "@/app/(app)/settings/services/actions";

const ID_A = "00000000-0000-4000-8000-00000000000a";
const ID_B = "00000000-0000-4000-8000-00000000000b";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(() => {
  state.role = "practitioner";
  state.touched = [];
});

async function settled(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// A refusal is either a thrown owner-only error or a returned ok:false.
const OWNER_ERROR = /Only (the )?studio owners?\b/i;
function refusedAtGate(o: { value?: unknown; error?: string }): boolean {
  if (o.error !== undefined) return OWNER_ERROR.test(o.error);
  const v = o.value as { ok?: unknown; code?: unknown } | undefined;
  return !!v && v.ok === false;
}

const CASES: Array<{ name: string; run: () => Promise<unknown> }> = [
  { name: "waiveAppointmentFeeAction", run: () => waiveAppointmentFeeAction(form({ appointment_id: ID_A, amount_cents: "100", note: "Synthetic" })) },
  { name: "supersedeAppointmentSettlementAction", run: () => supersedeAppointmentSettlementAction(form({ settlement_id: ID_B, appointment_id: ID_A, method: "paid_cash", amount_cents: "100", reason: "Synthetic correction" })) },
  { name: "startStripeConnectOnboardingAction", run: () => startStripeConnectOnboardingAction() },
  { name: "refreshStripeStatusAction", run: () => refreshStripeStatusAction() },
  { name: "openStripeDashboardAction", run: () => openStripeDashboardAction() },
  { name: "createServiceAction", run: () => createServiceAction(form({ name: "Synthetic", default_duration_minutes: "30", price_dollars: "10" })) },
  { name: "updateServiceAction", run: () => updateServiceAction(form({ id: ID_B, name: "Synthetic", default_duration_minutes: "30", price_dollars: "10" })) },
  { name: "moveServiceAction", run: () => moveServiceAction({ id: ID_B, move: "up" as never, expectedPosition: 1 }) },
  { name: "toggleServiceActiveAction", run: () => toggleServiceActiveAction(form({ id: ID_B, active: "false" })) },
];

describe("a non-owner is refused at the gate, with zero database or Stripe access", () => {
  for (const role of ["practitioner", "receptionist", "admin", ""]) {
    it.each(CASES)(`$name (role ${JSON.stringify(role)})`, async ({ run }) => {
      state.role = role;
      const outcome = await settled(run);
      expect(refusedAtGate(outcome), JSON.stringify(outcome)).toBe(true);
      expect(state.touched, "no database client or Stripe call may be reached for a non-owner").toEqual([]);
    });
  }

  it("a forged owner claim in the form changes nothing: the role is never read from the request", async () => {
    state.role = "practitioner";
    const outcome = await settled(() =>
      createServiceAction(form({ name: "Synthetic", default_duration_minutes: "30", price_dollars: "10", role: "owner", is_owner: "true" })),
    );
    expect(refusedAtGate(outcome)).toBe(true);
    expect(state.touched).toEqual([]);
  });
});

describe("positive control: the owner passes the gate and reaches the database or Stripe", () => {
  it.each(CASES)("$name", async ({ run }) => {
    state.role = "owner";
    const outcome = await settled(run);
    expect(state.touched.length, JSON.stringify(outcome)).toBeGreaterThan(0);
    expect(outcome.error ?? "").not.toMatch(OWNER_ERROR);
    if (outcome.value && typeof outcome.value === "object") {
      expect((outcome.value as { code?: string }).code).not.toBe("not_owner");
    }
  });
});
