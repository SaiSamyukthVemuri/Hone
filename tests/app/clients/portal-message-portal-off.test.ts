import { beforeEach, describe, expect, it, vi } from "vitest";

// HON-47: createPortalMessageAction must refuse, on the server, when the studio's client portal is off or its policy is
// unreadable: no message row, no email. The UI may hide or explain the action; this is the authority.

const m = vi.hoisted(() => ({
  access: { allowed: true, studioName: "Studio" } as { allowed: boolean; studioName: string | null },
  inserts: 0,
  emails: 0,
  askedStudios: [] as string[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({ practitioner: { id: "p1", active: true }, studio: { id: "s1", name: "Studio", slug: "studio" } }),
}));
vi.mock("@/lib/rate-limit/public", () => ({ limitPractitionerClientEmail: async () => ({ allowed: true }) }));
vi.mock("@/lib/portal/portal-access-gate", () => ({ studioPortalAccess: async (_admin: unknown, studioId: string) => { m.askedStudios.push(studioId); return m.access; } }));
vi.mock("@/lib/email/send-appointment", () => ({ sendEmailSafely: async () => { m.emails += 1; return { ok: true }; } }));
vi.mock("@/lib/email/studio-identity", () => ({ resolveReplyTo: () => null, studioClientContactEmail: () => null }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("@/lib/logging/safe-log", () => ({ safeLog: { error: () => undefined, warn: () => undefined, info: () => undefined } }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      for (const k of ["select", "eq", "update", "is", "order", "limit"]) chain[k] = self;
      chain.maybeSingle = async () => ({ data: { id: "c1", name: "Client", email: "c@example.test", archived_at: null }, error: null });
      chain.single = async () => ({ data: { id: "m1" }, error: null });
      chain.insert = () => {
        if (table === "client_portal_messages") m.inserts += 1;
        return chain;
      };
      return chain;
    },
  }),
}));

import { createPortalMessageAction } from "@/app/(app)/clients/[id]/portal-messages-actions";

function form() {
  const f = new FormData();
  f.set("client_id", "c1");
  f.set("subject", "Hello");
  f.set("body", "A message");
  return f;
}

beforeEach(() => {
  m.access = { allowed: true, studioName: "Studio" };
  m.inserts = 0;
  m.emails = 0;
  m.askedStudios = [];
});

describe("createPortalMessageAction with the client portal off", () => {
  it("portal off: refused with the studio's message, no row, no email", async () => {
    m.access = { allowed: false, studioName: "Studio" };
    const r = await createPortalMessageAction(form());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Studio/);
    expect(m.inserts).toBe(0);
    expect(m.emails).toBe(0);
  });
  it("unreadable policy (allowed false, no studio name): refused, nothing written or sent", async () => {
    m.access = { allowed: false, studioName: null };
    const r = await createPortalMessageAction(form());
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/off for this studio, or could not be confirmed/) });
    expect(m.inserts).toBe(0);
    expect(m.emails).toBe(0);
  });
  it("the policy asked about is the SESSION's studio, never another", async () => {
    await createPortalMessageAction(form());
    expect(m.askedStudios).toEqual(["s1"]);
  });
  it("positive control: portal on writes the message", async () => {
    const r = await createPortalMessageAction(form());
    expect(m.inserts).toBe(1);
    expect(r.ok).toBe(true);
  });
});
