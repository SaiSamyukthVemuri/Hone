import { beforeEach, describe, expect, it, vi } from "vitest";

// STUDIO-READY-02b (#824): the owner invites a receptionist through the
// existing invite action. The studio and inviter come from the server; the
// browser chooses only email, name and one of three roles.

const ctx = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  rows: {} as Record<string, unknown[]>,
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  sent: 0,
  summary: null as unknown,
  insertError: null as null | { message: string; code?: string },
  rpcCalls: [] as Array<[string, unknown]>,
}));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike"]) b[m] = () => b;
  b.maybeSingle = async () => ({ data: (ctx.rows[table] ?? [])[0] ?? null, error: null });
  b.insert = async (row: Record<string, unknown>) => {
    if (ctx.insertError) return { error: ctx.insertError };
    ctx.inserted.push({ table, row });
    return { error: null };
  };
  return b;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => builder(t) }) }));
// The owner's front desk summary (0390): the switch and the seat numbers, from a service-role command that re-verifies the owner.
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: unknown) => {
      ctx.rpcCalls.push([fn, args]);
      return { data: ctx.summary, error: null };
    },
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "owner-practitioner", role: ctx.role, display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  }),
}));
vi.mock("@/lib/email/client", () => ({
  getResendTransport: () => ({ emails: { send: async () => ((ctx.sent += 1), { data: { id: "m" }, error: null }) } }),
  FROM_ADDRESS: "Hone <noreply@example.test>",
}));

const { invitePractitionerAction } = await import("@/app/(app)/settings/team/actions");

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

beforeEach(() => {
  ctx.role = "owner";
  ctx.rows = {};
  ctx.inserted = [];
  ctx.sent = 0;
  ctx.insertError = null;
  ctx.rpcCalls = [];
  ctx.summary = { status: "ok", switch_on: true, seat_limit: 2, seats_active: 0, seats_reserved: 0, seats_available: 2, seats_over_limit: 0 };
});

describe("inviting a receptionist", () => {
  it("records a receptionist invitation for the SERVER-resolved studio and inviter", async () => {
    const r = await invitePractitionerAction(
      form({ email: "Desk@Example.test", role: "receptionist", display_name: "Front Desk", studio_id: "forged" }),
    );
    expect(r).toEqual({ ok: true, email: "desk@example.test" });
    expect(ctx.inserted).toEqual([
      {
        table: "pending_invitations",
        row: {
          studio_id: "studio-1",
          email: "desk@example.test",
          invited_by: "owner-practitioner",
          role: "receptionist",
          display_name: "Front Desk",
          status: "pending",
        },
      },
    ]);
  });

  it("asks the server-resolved owner's summary, with the studio and practitioner from the session and never from the form", async () => {
    await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist", studio_id: "forged" }));
    expect(ctx.rpcCalls).toEqual([["owner_front_desk_summary", { p_studio_id: "studio-1", p_owner_practitioner_id: "owner-practitioner" }]]);
  });

  it("refuses a receptionist invitation, with plain words and no write, when the Front Desk is not switched on for the studio", async () => {
    ctx.summary = { status: "ok", switch_on: false, seat_limit: 0, seats_active: 0, seats_reserved: 0, seats_available: 0, seats_over_limit: 0 };
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r).toEqual({ ok: false, error: "The front desk is not switched on for this studio." });
    expect(ctx.inserted).toEqual([]);
  });

  it("refuses it when no seat is free (active seats and pending invitations both count)", async () => {
    ctx.summary = { status: "ok", switch_on: true, seat_limit: 1, seats_active: 0, seats_reserved: 1, seats_available: 0, seats_over_limit: 0 };
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r.ok).toBe(false);
    expect(ctx.inserted).toEqual([]);
  });

  it("a summary that cannot be read fails closed for a receptionist invitation, and is never consulted for a practitioner", async () => {
    ctx.summary = { status: "not_authorized" };
    expect((await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }))).ok).toBe(false);
    expect(ctx.inserted).toEqual([]);
    ctx.rpcCalls = [];
    expect((await invitePractitionerAction(form({ email: "p@example.test", role: "practitioner" }))).ok).toBe(true);
    expect(ctx.rpcCalls).toEqual([]);
  });

  it("a race for the last seat lands on the database: its refusal is shown in plain words, and nothing else is written", async () => {
    ctx.insertError = { message: "front_desk_seat_limit_reached", code: "P0001" };
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/no free front-desk seats/i);
    expect(ctx.sent).toBe(0);
  });

  it("refuses an email already on this studio's front desk", async () => {
    ctx.rows = { studio_receptionists: [{ id: "existing" }] };
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r).toEqual({ ok: false, error: "desk@example.test is already on this studio's front desk." });
    expect(ctx.inserted).toEqual([]);
  });

  it("an unknown role from the browser falls back to practitioner, never to anything wider", async () => {
    await invitePractitionerAction(form({ email: "someone@example.test", role: "platform_admin" }));
    expect(ctx.inserted[0].row.role).toBe("practitioner");
  });

  it("a non-owner cannot invite anyone, and nothing is written", async () => {
    ctx.role = "practitioner";
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r.ok).toBe(false);
    expect(ctx.inserted).toEqual([]);
  });
});
