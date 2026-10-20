import { beforeEach, describe, expect, it, vi } from "vitest";

// STUDIO-READY-02b (#824): the owner invites a receptionist through the
// existing invite action. The studio and inviter come from the server; the
// browser chooses only email, name and one of three roles.

const ctx = vi.hoisted(() => ({
  role: "owner" as "owner" | "practitioner",
  rows: {} as Record<string, unknown[]>,
  lookupErrors: {} as Record<string, { code: string; message: string }>,
  lookups: [] as string[],
  inserted: [] as Array<{ table: string; row: Record<string, unknown> }>,
  sent: 0,
  messages: [] as Array<{ html: string; text: string }>,
}));

function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike"]) b[m] = () => b;
  b.maybeSingle = async () => {
    ctx.lookups.push(table);
    return { data: (ctx.rows[table] ?? [])[0] ?? null, error: ctx.lookupErrors[table] ?? null };
  };
  b.insert = async (row: Record<string, unknown>) => {
    ctx.inserted.push({ table, row });
    return { error: null };
  };
  return b;
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => builder(t) }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "owner-practitioner", role: ctx.role, display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  }),
}));
vi.mock("@/lib/email/client", () => ({
  resend: { emails: { send: async (message: { html: string; text: string }) => {
    ctx.sent += 1;
    ctx.messages.push(message);
    return { data: { id: "m" }, error: null };
  } } },
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
  ctx.lookupErrors = {};
  ctx.lookups = [];
  ctx.inserted = [];
  ctx.sent = 0;
  ctx.messages = [];
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

  it("the fake invitation transport describes explicit joining without promising automatic access", async () => {
    const result = await invitePractitionerAction(form({ email: "desk@harness.local", role: "receptionist" }));
    expect(result.ok).toBe(true);
    expect(ctx.messages).toHaveLength(1);
    for (const body of [ctx.messages[0].html, ctx.messages[0].text]) {
      expect(body).toContain("desk@harness.local");
      expect(body).toContain("Complete the joining steps shown after signing in.");
      expect(body).not.toContain("automatically");
    }
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

  it.each([
    ["practitioners", "Could not check existing practitioners."],
    ["studio_receptionists", "Could not check the front desk team."],
    ["pending_invitations", "Could not check existing invitations."],
  ])("refuses a %s lookup error before insertion or sending", async (table, message) => {
    ctx.lookupErrors[table] = { code: "42501", message: "private database detail" };
    const result = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(ctx.lookups).toContain(table);
    expect(result).toEqual({ ok: false, error: message });
    expect(ctx.inserted).toEqual([]);
    expect(ctx.sent).toBe(0);
    expect(ctx.messages).toEqual([]);
  });

  it("a non-owner cannot invite anyone, and nothing is written", async () => {
    ctx.role = "practitioner";
    const r = await invitePractitionerAction(form({ email: "desk@example.test", role: "receptionist" }));
    expect(r.ok).toBe(false);
    expect(ctx.inserted).toEqual([]);
  });
});
