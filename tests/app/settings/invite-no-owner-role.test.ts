import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// Team R1 note section 5 Q4: an invitation can never carry the owner role. Ownership moves only through its own protected flow.

const insert = vi.hoisted(() => vi.fn(async () => ({ error: null })));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/email/client", () => ({ resend: { emails: { send: vi.fn(async () => ({ data: { id: "x" }, error: null })) } }, FROM_ADDRESS: "Hone <hello@hone.care>" }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "p1", role: "owner", display_name: "Owner", email: "owner@example.test" },
    studio: { id: "s1", name: "Synthetic Studio" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "ilike"]) chain[m] = () => chain;
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.insert = insert;
    return { from: () => chain };
  }),
}));

import { invitePractitionerAction } from "@/app/(app)/settings/team/actions";

const form = (role: string) => {
  const fd = new FormData();
  fd.set("email", "invitee.synthetic@example.test");
  fd.set("role", role);
  return fd;
};

describe("invitePractitionerAction refuses the owner role", () => {
  it("refuses role=owner and writes no invitation", async () => {
    insert.mockClear();
    const result = await invitePractitionerAction(form("owner"));
    expect(result.ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
  it("refuses an unknown role the same way", async () => {
    insert.mockClear();
    expect((await invitePractitionerAction(form("admin"))).ok).toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
  it("still invites a practitioner", async () => {
    insert.mockClear();
    expect((await invitePractitionerAction(form("practitioner"))).ok).toBe(true);
    expect(insert).toHaveBeenCalled();
  });
  it("the invite form offers no Owner option", () => {
    const src = readFileSync("app/(app)/settings/team/InviteForm.tsx", "utf8");
    expect(src).not.toContain('value="owner"');
  });
});
