import { beforeEach, describe, expect, it, vi } from "vitest";

// Codex P2 on #1390: `*` is now a one-character wildcard, so many stored rows can match a typed address and an unordered .limit(50) can cut
// the real member off the page. A FULL page proves nothing about absence, so the duplicate checks must refuse (fail closed), never insert.

const h = vi.hoisted(() => ({
  practitioners: [] as Array<{ id: string; email: string }>,
  invites: [] as Array<{ id: string; email: string }>,
  inserted: 0,
  send: vi.fn(async () => ({ data: { id: "m" }, error: null })),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/email/client", () => ({ resend: { emails: { send: h.send } }, FROM_ADDRESS: "Hone <hello@hone.care>" }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "practitioner-1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "studio-1", name: "Synthetic Studio" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: (table: string) => {
      let cap = Infinity;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "ilike"]) chain[m] = () => chain;
      chain.limit = (n: number) => { cap = n; return chain; };
      chain.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: (table === "practitioners" ? h.practitioners : h.invites).slice(0, cap), error: null });
      chain.insert = async () => { h.inserted += 1; return { error: null }; };
      return chain;
    },
  })),
}));

import { invitePractitionerAction } from "@/app/(app)/settings/team/actions";

const TYPED = "bob**jones@example.test";
const lookalikes = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, email: `bob${String(i).padStart(2, "0")}jones@example.test` }));
function form(): FormData {
  const fd = new FormData();
  fd.set("email", TYPED);
  fd.set("role", "practitioner");
  return fd;
}

beforeEach(() => {
  h.practitioners = [];
  h.invites = [];
  h.inserted = 0;
  h.send.mockClear();
});

describe("team invite: duplicate checks fail closed on a full candidate page", () => {
  it("51 lookalike practitioners plus the real member beyond the page: refuse, no insert, no email", async () => {
    h.practitioners = [...lookalikes(51), { id: "real", email: TYPED }];
    const r = await invitePractitionerAction(form());
    expect(r).toMatchObject({ ok: false, error: "Could not check existing practitioners." });
    expect(h.inserted).toBe(0);
    expect(h.send).not.toHaveBeenCalled();
  });
  it("the same for pending invitations", async () => {
    h.invites = [...lookalikes(51), { id: "real", email: TYPED }];
    const r = await invitePractitionerAction(form());
    expect(r).toMatchObject({ ok: false, error: "Could not check existing invitations." });
    expect(h.inserted).toBe(0);
  });
  it("a short page with the real member on it is still reported as already a practitioner", async () => {
    h.practitioners = [...lookalikes(3), { id: "real", email: TYPED }];
    const r = await invitePractitionerAction(form());
    expect(r).toMatchObject({ ok: false });
    expect((r as { error: string }).error).toContain("already a practitioner");
    expect(h.inserted).toBe(0);
  });
  it("a short page of lookalikes only (no exact row) proceeds to the insert", async () => {
    h.practitioners = lookalikes(3);
    await invitePractitionerAction(form());
    expect(h.inserted).toBe(1);
  });
});
