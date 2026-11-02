import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Owner-side receptionist role assignment: invite (flag-gated) and remove (never flag-gated). Synthetic values only.

type Ctx = { practitioner: { id: string; role: string; active: boolean }; studio: { id: string } };
let ctx: Ctx | Error;
const inserts: Array<Record<string, unknown>> = [];
const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: "updated", error: null };
let existing: { practitioner: unknown; receptionist: unknown; pending: unknown } = { practitioner: null, receptionist: null, pending: null };
let insertError: { code?: string } | null = null;

function chain(table: string) {
  const result = () => {
    const data = table === "practitioners" ? existing.practitioner : table === "studio_receptionists" ? existing.receptionist : existing.pending;
    return Promise.resolve({ data, error: null });
  };
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "ilike"]) q[m] = () => q;
  q.maybeSingle = result;
  q.insert = (row: Record<string, unknown>) => {
    inserts.push(row);
    return Promise.resolve({ error: insertError });
  };
  return q;
}

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: (t: string) => chain(t) }) }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcs.push({ fn, args });
      return rpcResult;
    },
  }),
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    if (ctx instanceof Error) throw ctx;
    return ctx;
  },
}));

import { inviteReceptionistAction, removeReceptionistAccessAction } from "@/app/(app)/settings/team/receptionist-actions";

const OWNER: Ctx = { practitioner: { id: "owner-1", role: "owner", active: true }, studio: { id: "studio-1" } };
const RID = "11111111-2222-4333-8444-555555555555";
const form = (entries: Array<[string, string]>) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

beforeEach(() => {
  ctx = OWNER;
  inserts.length = 0;
  rpcs.length = 0;
  rpcResult = { data: "updated", error: null };
  existing = { practitioner: null, receptionist: null, pending: null };
  insertError = null;
  vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "true");
});
afterEach(() => vi.unstubAllEnvs());

describe("inviteReceptionistAction", () => {
  it("flag off: refused before any read or write", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "false");
    const out = await inviteReceptionistAction(form([["email", "desk@example.test"]]));
    expect(out).toEqual({ ok: false, error: "This is not available." });
    expect(inserts).toEqual([]);
  });

  it("creates ONE pending receptionist invitation for the session's studio, never from a posted studio id", async () => {
    const out = await inviteReceptionistAction(form([["email", " Desk@Example.test "], ["display_name", "Front Desk"], ["studio_id", "other-studio"]]));
    expect(out).toEqual({ ok: true, email: "desk@example.test" });
    expect(inserts).toEqual([{ studio_id: "studio-1", email: "desk@example.test", invited_by: "owner-1", role: "receptionist", display_name: "Front Desk", status: "pending" }]);
  });

  it("owner only: a practitioner or an inactive owner is refused", async () => {
    ctx = { practitioner: { id: "p1", role: "practitioner", active: true }, studio: { id: "studio-1" } };
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toMatchObject({ ok: false, error: "Only studio owners can manage the team." });
    ctx = { practitioner: { id: "o2", role: "owner", active: false }, studio: { id: "studio-1" } };
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toMatchObject({ ok: false });
    ctx = new Error("no session");
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toEqual({ ok: false, error: "Unauthorized." });
    expect(inserts).toEqual([]);
  });

  it("refuses a malformed email, an existing practitioner, an active receptionist and a pending invite", async () => {
    expect(await inviteReceptionistAction(form([["email", "nope"]]))).toMatchObject({ ok: false, error: "Enter a valid email address." });
    existing.practitioner = { id: "x" };
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toMatchObject({ ok: false });
    existing = { practitioner: null, receptionist: { id: "x" }, pending: null };
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toMatchObject({ ok: false });
    existing = { practitioner: null, receptionist: null, pending: { id: "x" } };
    expect(await inviteReceptionistAction(form([["email", "desk@example.test"]]))).toMatchObject({ ok: false });
    expect(inserts).toEqual([]);
  });

  it("never creates an account or a membership: the only write is the invitation row", async () => {
    await inviteReceptionistAction(form([["email", "desk@example.test"]]));
    expect(rpcs).toEqual([]);
    expect(inserts).toHaveLength(1);
  });
});

describe("removeReceptionistAccessAction", () => {
  it("calls the locked deactivation command with the SESSION studio and owner, p_active false", async () => {
    const out = await removeReceptionistAccessAction(form([["id", RID], ["studio_id", "other-studio"]]));
    expect(out).toEqual({ ok: true });
    expect(rpcs).toEqual([{ fn: "set_studio_receptionist_active", args: { p_studio_id: "studio-1", p_owner_practitioner_id: "owner-1", p_receptionist_id: RID, p_active: false } }]);
  });

  it("is NOT flag-gated: with the flag off the owner can still revoke", async () => {
    vi.stubEnv("HONE_RECEPTIONIST_DESK_ENABLED", "false");
    expect(await removeReceptionistAccessAction(form([["id", RID]]))).toEqual({ ok: true });
    expect(rpcs).toHaveLength(1);
  });

  it("owner only, and a non-uuid id never reaches the database", async () => {
    ctx = { practitioner: { id: "p1", role: "practitioner", active: true }, studio: { id: "studio-1" } };
    expect(await removeReceptionistAccessAction(form([["id", RID]]))).toMatchObject({ ok: false });
    ctx = OWNER;
    expect(await removeReceptionistAccessAction(form([["id", "not-a-uuid"]]))).toEqual({ ok: false, error: "Receptionist not found." });
    expect(rpcs).toEqual([]);
  });

  it("maps the command's answers: no_change is ok, not_found and not_authorized are refused, an error is generic", async () => {
    rpcResult = { data: "no_change", error: null };
    expect(await removeReceptionistAccessAction(form([["id", RID]]))).toEqual({ ok: true });
    rpcResult = { data: "not_found", error: null };
    expect(await removeReceptionistAccessAction(form([["id", RID]]))).toEqual({ ok: false, error: "Receptionist not found." });
    rpcResult = { data: "not_authorized", error: null };
    expect(await removeReceptionistAccessAction(form([["id", RID]]))).toMatchObject({ ok: false });
    rpcResult = { data: null, error: { code: "XX000", message: "secret detail" } };
    const out = await removeReceptionistAccessAction(form([["id", RID]]));
    expect(out).toEqual({ ok: false, error: "Could not remove access. Please try again." });
  });
});
