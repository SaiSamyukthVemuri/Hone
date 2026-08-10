import { describe, it, expect, vi, beforeEach } from "vitest";

// B6 / 0175 — markAppointmentCompleteAction's RPC error map.
//
// BEHAVIOURAL, not a source grep: the real action runs, with the admin client
// stubbed so a chosen RPC error comes back. 0175 changed the refusal the
// database raises from 'appointment has not yet ended' to 'appointment has not
// started yet'; an action still matching only the old text would have fallen
// through to the generic message and told the practitioner nothing useful —
// while the UI elsewhere claimed the button unlocks at the start time.
//
// The error path returns before the postcare/revalidate imports, so only the
// practitioner lookup and the admin client need stubbing.

const rpcError: { value: { message: string; code?: string } | null } = { value: null };

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: "owner", active: true },
    studio: { id: "studio-1", timezone: "America/Toronto" },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async () => ({ error: rpcError.value }),
  }),
}));

import { markAppointmentCompleteAction } from "@/app/(app)/calendar/actions";

function fd(): FormData {
  const f = new FormData();
  f.set("appointment_id", "11111111-1111-1111-1111-111111111111");
  return f;
}

async function errorFor(message: string): Promise<string> {
  rpcError.value = { message, code: "P0002" };
  const res = await markAppointmentCompleteAction(fd());
  expect(res.ok).toBe(false);
  return res.ok === false ? res.error : "";
}

beforeEach(() => {
  rpcError.value = null;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("B6 — the completion error map matches what 0175 actually raises", () => {
  it("maps 0175's refusal to start-time copy, never end-time copy", async () => {
    const err = await errorFor("appointment has not started yet");
    expect(err).toBe("This appointment hasn't started yet.");
    // The old sentence must not resurface for the new refusal: it would
    // describe a rule the database no longer enforces.
    expect(err).not.toMatch(/ended/i);
  });

  it("still recognises the PRE-0175 refusal, for deployment/rollback skew", async () => {
    // B6-aware application code can briefly run against a 0174 database. There
    // the end-time rule is the one actually being enforced, so saying so stays
    // truthful — this branch is never used to explain the 0175 refusal.
    const err = await errorFor("appointment has not yet ended");
    expect(err).toBe("This appointment hasn't ended yet.");
  });

  it("keeps the not-confirmed mapping", async () => {
    const err = await errorFor("appointment is not confirmed (current: cancelled)");
    expect(err).toBe("Only confirmed appointments can be marked complete.");
  });

  it("falls back to the safe generic message for anything unrecognised", async () => {
    const err = await errorFor("some unexpected database condition");
    expect(err).toBe("Could not mark this appointment complete.");
  });

  it("never leaks raw database text to the UI", async () => {
    // A leaked message can carry schema names, constraint names or row values.
    const raw =
      'duplicate key value violates unique constraint "appointments_pkey" DETAIL: Key (id)=(x) exists.';
    const err = await errorFor(raw);
    expect(err).toBe("Could not mark this appointment complete.");
    expect(err).not.toContain("constraint");
    expect(err).not.toContain("DETAIL");
  });
});
