import { beforeEach, describe, expect, it, vi } from "vitest";

// Restoring a terminal appointment to confirmed can land on a start the same client already holds for the same service (one live appointment per client,
// service and start). That unique violation is answered as the taken time it is; any other database error stays the generic failure.

const h = vi.hoisted(() => ({ rpcError: null as null | { code?: string; message?: string }, rpcData: "ok" as unknown }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { user_id: "u-1" }, studio: { id: "s-1" } }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({ rpc: async () => ({ data: h.rpcError ? null : h.rpcData, error: h.rpcError }) }),
}));

import { revertAppointmentOutcomeAction } from "@/app/(app)/calendar/appointment-repair-actions";

const INPUT = { appointmentId: "11111111-1111-4111-8111-111111111111", expectedStatus: "completed" as const, reason: "entered by mistake" };
const RULE = 'duplicate key value violates unique constraint "appointments_one_live_per_client_service_start"';
const TAKEN = "That time is now booked by another appointment, so this one cannot be restored.";

beforeEach(() => {
  h.rpcError = null;
  h.rpcData = "ok";
});

describe("revert to confirmed: the one-live-appointment unique violation", () => {
  it("answers as a taken time, not the generic failure", async () => {
    h.rpcError = { code: "23505", message: RULE };
    expect(await revertAppointmentOutcomeAction(INPUT)).toEqual({ ok: false, error: TAKEN });
  });
  it("a DIFFERENT unique violation stays the generic failure", async () => {
    h.rpcError = { code: "23505", message: 'duplicate key value violates unique constraint "some_other_unique"' };
    const r = await revertAppointmentOutcomeAction(INPUT);
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).not.toBe(TAKEN);
  });
  it("a successful restore is unchanged", async () => {
    expect(await revertAppointmentOutcomeAction(INPUT)).toEqual({ ok: true });
  });
});
