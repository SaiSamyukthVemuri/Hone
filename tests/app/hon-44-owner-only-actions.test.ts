import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-44 / Sam decision 12 (2026-10-25): finances, card charges and price
// changes are OWNER-ONLY; a practitioner adds pinned cautions and edits their
// own, only the owner deletes them. This file runs every affected server action
// for real against RECORDING stubs for the database, and asserts two things:
//
//   NON-OWNER  -> a closed refusal, and ZERO database access of any kind. The
//                 recorder counts every property read and call on both the
//                 user-session client and the service-role client, so a gate
//                 placed after a read fails here.
//   OWNER      -> the gate lets the action through to its first database access
//                 (positive control: a refusal for everyone would also satisfy
//                 the first assertion).
//
// The role is flipped per test and the action must derive the decision from the
// authenticated practitioner alone; no form field carries it. Synthetic data.

const state = vi.hoisted(() => ({
  role: "practitioner" as string,
  touched: [] as string[],
  eqs: [] as Array<[string, unknown]>,
}));

function recorder(label: string): unknown {
  const target = function () {};
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === "then") return undefined; // never look like a thenable
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
    studio: { id: "studio-1", timezone: "America/Toronto" },
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));
vi.mock("@/lib/analytics/server", () => ({ captureServerEvent: async () => {} }));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

import {
  prepareSessionPaymentChargeAction,
  executeSessionPaymentChargeAction,
  sendPaymentChargeReceiptAction,
} from "@/app/(app)/clients/[id]/sessions/[sessionId]/payment-actions";
import {
  prepareManualFeeChargeAction,
  chargeManualFeeAttemptAction,
  cancelManualFeeChargeAttemptAction,
  sendFeeReceiptAction,
} from "@/app/(app)/calendar/[id]/manual-fee-actions";
import { recordAppointmentSettlementAction } from "@/app/(app)/appointment-settlement-actions";
import { getQuickCheckoutContextAction } from "@/app/(app)/quick-checkout-actions";
import { updateSessionPriceAction } from "@/app/(app)/clients/[id]/sessions/[sessionId]/actions";
import { addClientPricingAction, deleteClientPricingAction } from "@/app/(app)/clients/[id]/actions";
import {
  editClientPinnedNoteAction,
  removeClientPinnedNoteAction,
} from "@/app/(app)/clients/[id]/pinned-notes-actions";

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
  state.eqs = [];
});

async function settled(run: () => Promise<unknown>): Promise<{ value?: unknown; error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

type Case = {
  name: string;
  run: () => Promise<unknown>;
  /** True when the (already settled) outcome is the closed refusal. */
  refused: (outcome: { value?: unknown; error?: string }) => boolean;
};

const notAuthorized = (o: { value?: unknown; error?: string }) =>
  typeof o.value === "object" && o.value !== null && (o.value as { ok?: unknown }).ok === false;

const CASES: Case[] = [
  {
    name: "prepareSessionPaymentChargeAction",
    run: () => prepareSessionPaymentChargeAction(form({ session_id: ID_A, expected_amount_cents: "100" })),
    refused: notAuthorized,
  },
  {
    name: "executeSessionPaymentChargeAction",
    run: () => executeSessionPaymentChargeAction(form({ attempt_id: ID_A, confirm_charge: "true" })),
    refused: (o) => notAuthorized(o) && (o.value as { outcome?: string }).outcome === "not_authorized",
  },
  {
    name: "sendPaymentChargeReceiptAction",
    run: () => sendPaymentChargeReceiptAction(form({ attempt_id: ID_A, client_id: ID_B, session_id: ID_A })),
    refused: (o) => notAuthorized(o) && (o.value as { outcome?: string }).outcome === "not_authorized",
  },
  {
    name: "prepareManualFeeChargeAction",
    run: () => prepareManualFeeChargeAction(form({ appointment_id: ID_A, charge_type: "no_show", internal_note: "Synthetic reason" })),
    refused: notAuthorized,
  },
  {
    name: "chargeManualFeeAttemptAction",
    run: () => chargeManualFeeAttemptAction(form({ attempt_id: ID_A, confirm_charge: "true" })),
    refused: (o) => notAuthorized(o) && (o.value as { outcome?: string }).outcome === "not_authorized",
  },
  {
    name: "cancelManualFeeChargeAttemptAction",
    run: () => cancelManualFeeChargeAttemptAction(form({ attempt_id: ID_A, cancelled_reason: "x" })),
    refused: notAuthorized,
  },
  {
    name: "sendFeeReceiptAction",
    run: () => sendFeeReceiptAction(form({ attempt_id: ID_A, appointment_id: ID_B })),
    refused: notAuthorized,
  },
  {
    name: "recordAppointmentSettlementAction",
    run: () => recordAppointmentSettlementAction(form({ appointment_id: ID_A, method: "paid_cash", amount_cents: "5000" })),
    refused: (o) => notAuthorized(o) && (o.value as { code?: string }).code === "not_owner",
  },
  {
    name: "getQuickCheckoutContextAction",
    run: () => getQuickCheckoutContextAction(ID_A),
    refused: (o) => notAuthorized(o) && (o.value as { isOwner?: boolean }).isOwner === false,
  },
  {
    name: "updateSessionPriceAction",
    run: () => updateSessionPriceAction(form({ session_id: ID_A, client_id: ID_B, price_dollars: "10" })),
    refused: (o) => /Only the studio owner/.test(o.error ?? ""),
  },
  {
    name: "addClientPricingAction",
    run: () => addClientPricingAction(form({ client_id: ID_B, service_name: "Synthetic", price: "10" })),
    refused: (o) => /Only the studio owner/.test(o.error ?? ""),
  },
  {
    name: "deleteClientPricingAction",
    run: () => deleteClientPricingAction(form({ id: ID_A, client_id: ID_B })),
    refused: (o) => /Only the studio owner/.test(o.error ?? ""),
  },
  {
    name: "removeClientPinnedNoteAction",
    run: () => removeClientPinnedNoteAction(form({ note_id: ID_A, client_id: ID_B })),
    refused: (o) => /Only the studio owner/.test(o.error ?? ""),
  },
];

describe("a non-owner is refused, with zero database access", () => {
  it.each(CASES)("$name", async ({ run, refused }) => {
    state.role = "practitioner";
    const outcome = await settled(run);
    expect(refused(outcome), JSON.stringify(outcome)).toBe(true);
    expect(state.touched, "no database client may be created or used for a non-owner").toEqual([]);
  });

  it("a forged owner claim in the form changes nothing: the role is never read from the request", async () => {
    state.role = "practitioner";
    const outcome = await settled(() =>
      recordAppointmentSettlementAction(
        form({ appointment_id: ID_A, method: "paid_cash", amount_cents: "5000", is_owner: "true", role: "owner" }),
      ),
    );
    expect((outcome.value as { code?: string }).code).toBe("not_owner");
    expect(state.touched).toEqual([]);
  });

  it("an inactive-looking or unknown role is not an owner either", async () => {
    for (const role of ["receptionist", "admin", ""]) {
      state.role = role;
      state.touched = [];
      const outcome = await settled(() => getQuickCheckoutContextAction(ID_A));
      expect((outcome.value as { ok?: boolean }).ok, role).toBe(false);
      expect(state.touched, role).toEqual([]);
    }
  });
});

describe("positive control: the owner passes the gate and reaches the database", () => {
  it.each(CASES)("$name", async ({ run }) => {
    state.role = "owner";
    const outcome = await settled(run);
    // The action may still stop for another reason (the stub database is a
    // recorder, not a studio), but it must NOT stop at the owner gate, and it must
    // have reached a database client.
    expect(state.touched.length, JSON.stringify(outcome)).toBeGreaterThan(0);
    expect(outcome.error ?? "").not.toMatch(/Only the studio owner/);
    if (outcome.value && typeof outcome.value === "object") {
      const v = outcome.value as { code?: string; outcome?: string; isOwner?: boolean };
      expect(v.code).not.toBe("not_owner");
      expect(v.outcome).not.toBe("not_authorized");
      if ("isOwner" in v) expect(v.isOwner).toBe(true);
    }
  });
});

describe("pinned cautions: edit own only, owner edits any", () => {
  function editForm() {
    return form({ note_id: ID_A, client_id: ID_B, text: "new text", original_text: "old text" });
  }

  // A scripted service-role builder that records every .eq(column, value).
  async function withAdminBuilder<T>(run: () => Promise<T>): Promise<T> {
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    builder.update = chain;
    builder.select = chain;
    builder.eq = (column: string, value: unknown) => {
      state.eqs.push([column, value]);
      return builder;
    };
    builder.maybeSingle = async () => ({ data: null, error: null });
    const admin = await import("@/lib/supabase/admin-server");
    vi.spyOn(admin, "createAdminClient").mockReturnValue({ from: () => builder } as never);
    try {
      return await run();
    } finally {
      vi.restoreAllMocks();
    }
  }

  it("a practitioner's update is scoped to cautions THEY created", async () => {
    state.role = "practitioner";
    const outcome = await withAdminBuilder(() => settled(() => editClientPinnedNoteAction(editForm())));
    expect(outcome.error).toMatch(/changed or is no longer available/);
    expect(state.eqs).toContainEqual(["created_by_practitioner_id", "prac-2"]);
    expect(state.eqs).toContainEqual(["studio_id", "studio-1"]);
  });

  it("the owner's update is NOT narrowed by author", async () => {
    state.role = "owner";
    await withAdminBuilder(() => settled(() => editClientPinnedNoteAction(editForm())));
    expect(state.eqs.map(([c]) => c)).not.toContain("created_by_practitioner_id");
    expect(state.eqs).toContainEqual(["studio_id", "studio-1"]);
  });

  it("a foreign or author-less caution gives a non-owner the same refusal as a missing one (no author disclosure)", async () => {
    state.role = "practitioner";
    const outcome = await withAdminBuilder(() => settled(() => editClientPinnedNoteAction(editForm())));
    expect(outcome.error).toBe("That note changed or is no longer available. Refresh and try again.");
  });
});
