import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// HON-47. Entry points that run BEFORE a portal session exists must honour the
// studio's client portal flag: the practitioner "send link" path, the verify
// action (which must not burn the single-use link), and the public login
// action. Synthetic data only. client_portal_enabled is the held 0252 column,
// so every case here is also a statement about today's schema: absent = allowed.

type Studio = Record<string, unknown> | null;
const state = {
  studio: { id: "s1", name: "Synthetic Studio" } as Studio,
  studioError: null as { code: string } | null,
  inserts: [] as Array<Record<string, unknown>>,
  consumed: 0,
  link: null as Record<string, unknown> | null,
};

function admin() {
  return {
    from(table: string) {
      if (table === "studios") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: state.studio, error: state.studioError }),
            }),
          }),
        };
      }
      if (table === "client_portal_magic_links") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.inserts.push(row);
            return { error: null };
          },
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: state.link, error: null }) }),
          }),
          update: () => ({
            eq: () => ({
              is: () => ({
                select: async () => {
                  state.consumed += 1;
                  return { data: [{ id: "l1" }], error: null };
                },
              }),
            }),
          }),
        };
      }
      if (table === "clients") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { id: "c1", studio_id: "s1", archived_at: null },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const sent: unknown[] = [];
const createSession = vi.fn(async () => undefined);
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://example.test" }));
vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (m: unknown) => {
    sent.push(m);
    return { ok: true };
  },
}));
vi.mock("@/lib/portal/session", () => ({ createPortalSession: (...a: unknown[]) => createSession(...(a as [])) }));
vi.mock("@/lib/portal/access-events", () => ({ logPortalAccessEvent: async () => undefined }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { issuePortalMagicLink } from "@/lib/portal/magic-link";
import { verifyPortalMagicLinkAction } from "@/app/portal/verify/[token]/actions";

const INPUT = { studioId: "s1", clientId: "c1", email: "a@example.test", studioName: "Synthetic Studio" };

beforeEach(() => {
  state.studio = { id: "s1", name: "Synthetic Studio" };
  state.studioError = null;
  state.inserts = [];
  state.consumed = 0;
  sent.length = 0;
  createSession.mockClear();
  state.link = {
    id: "l1",
    studio_id: "s1",
    client_id: "c1",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    consumed_at: null,
  };
});

describe("practitioner send link (issuePortalMagicLink)", () => {
  it("DEFAULT: the flag column absent (today's schema) sends the link", async () => {
    const r = await issuePortalMagicLink(admin() as never, INPUT);
    expect(r.ok).toBe(true);
    expect(state.inserts).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });
  it("client_portal_enabled = true sends the link", async () => {
    state.studio = { id: "s1", name: "Synthetic Studio", client_portal_enabled: true };
    expect((await issuePortalMagicLink(admin() as never, INPUT)).ok).toBe(true);
  });
  it("client_portal_enabled = false writes no row and sends no email, and says why", async () => {
    state.studio = { id: "s1", name: "Synthetic Studio", client_portal_enabled: false };
    const r = await issuePortalMagicLink(admin() as never, INPUT);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/Synthetic Studio/);
    expect(state.inserts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
  it("a non-boolean flag value is treated as off", async () => {
    state.studio = { id: "s1", name: "Synthetic Studio", client_portal_enabled: "yes" };
    expect((await issuePortalMagicLink(admin() as never, INPUT)).ok).toBe(false);
    expect(state.inserts).toHaveLength(0);
  });
  it("an unreadable policy fails closed: no row, no email", async () => {
    state.studio = null;
    state.studioError = { code: "XX000" };
    const r = await issuePortalMagicLink(admin() as never, INPUT);
    expect(r.ok).toBe(false);
    expect(state.inserts).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});

describe("verify action", () => {
  const run = () => {
    const fd = new FormData();
    fd.set("token", "tok-synthetic");
    return verifyPortalMagicLinkAction(fd).catch((e: Error) => e.message);
  };

  it("DEFAULT: consumes the link, creates the session, goes to /portal", async () => {
    expect(await run()).toBe("REDIRECT:/portal");
    expect(state.consumed).toBe(1);
    expect(createSession).toHaveBeenCalledTimes(1);
  });
  it("portal off: the single-use link is NOT consumed, no session, back to the explanation page", async () => {
    state.studio = { id: "s1", name: "Synthetic Studio", client_portal_enabled: false };
    expect(await run()).toBe("REDIRECT:/portal/verify/tok-synthetic");
    expect(state.consumed).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });
  it("unreadable policy: not consumed, no session", async () => {
    state.studio = null;
    state.studioError = { code: "XX000" };
    expect(await run()).toBe("REDIRECT:/portal/verify/tok-synthetic");
    expect(state.consumed).toBe(0);
    expect(createSession).not.toHaveBeenCalled();
  });
});

describe("public login action (source contract)", () => {
  const src = readFileSync(
    path.resolve(__dirname, "../../../app/portal/login/actions.ts"),
    "utf8",
  );
  it("checks the studio's portal access before generating a token or inserting a row", () => {
    const gate = src.indexOf("studioPortalAccess(admin, match.studioId)");
    const token = src.indexOf("generateRawToken();", gate);
    const insert = src.indexOf('.from("client_portal_magic_links")', gate);
    expect(gate).toBeGreaterThan(-1);
    expect(token).toBeGreaterThan(gate);
    expect(insert).toBeGreaterThan(gate);
  });
  it("a refused studio continues to the same generic success (no distinct response)", () => {
    expect(src).toMatch(/if \(!access\.allowed\) \{[\s\S]*?continue;/);
  });
});
