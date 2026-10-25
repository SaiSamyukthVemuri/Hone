import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// HON-47 — a studio may turn client PORTAL ACCESS off.
// ===========================================================================
//
// Proves, with synthetic studios and clients only:
//   * the session resolver never returns a usable session for a disabled
//     studio (every portal page and action passes through it);
//   * magic-link verify refuses BEFORE consuming the link, and never mints a
//     session;
//   * studio-scoped sign-in explains; unscoped sign-in issues no link and gives
//     the same generic answer as every other branch (no client enumeration);
//   * staff "send portal link" and staff portal messages refuse;
//   * a studio with no policy column (today's rows) behaves exactly as before.

vi.mock("server-only", () => ({}));

const STUDIO_ID = "00000000-0000-4000-8000-000000000047";
const CLIENT_ID = "00000000-0000-4000-8000-0000000000c1";

const state = vi.hoisted(() => ({
  cookie: "raw-session-cookie" as string | null,
  studio: { id: "", name: "Synthetic Studio", slug: "synthetic-studio" } as Record<string, unknown>,
  studioReadError: null as null | { code: string },
  link: null as null | Record<string, unknown>,
  writes: [] as Array<{ table: string; op: string; row?: unknown }>,
  redirects: [] as string[],
  emails: [] as Array<{ to: string }>,
  matches: [] as Array<{ studioId: string; clientId: string }>,
  rateLimited: [] as string[],
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "hone_portal_session" && state.cookie ? { value: state.cookie } : undefined,
    set: () => undefined,
  }),
  headers: async () => new Headers(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    state.redirects.push(to);
    throw new Error(`REDIRECT:${to}`);
  },
}));

function query(table: string) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    is: () => chain,
    insert: (row: unknown) => {
      state.writes.push({ table, op: "insert", row });
      return Promise.resolve({ error: null });
    },
    update: (row: unknown) => {
      state.writes.push({ table, op: "update", row });
      const u = {
        eq: () => u,
        is: () => u,
        select: async () => ({ data: [{ id: "link-1" }], error: null }),
        then: (ok: (v: { error: null }) => unknown) => ok({ error: null }),
      };
      return u;
    },
    maybeSingle: async () => {
      switch (table) {
        case "client_portal_sessions":
          return {
            data: {
              id: "sess-1",
              studio_id: STUDIO_ID,
              client_id: CLIENT_ID,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              revoked_at: null,
            },
            error: null,
          };
        case "studios":
          return state.studioReadError
            ? { data: null, error: state.studioReadError }
            : { data: { ...state.studio, id: STUDIO_ID }, error: null };
        case "client_portal_magic_links":
          return { data: state.link, error: null };
        case "clients":
          return { data: { id: CLIENT_ID, studio_id: STUDIO_ID, archived_at: null, email: "client@example.invalid" }, error: null };
        default:
          return { data: null, error: null };
      }
    },
  };
  return chain;
}

const admin = { from: (table: string) => query(table) };
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => admin }));
vi.mock("@/lib/portal/access-events", () => ({ logPortalAccessEvent: async () => undefined }));
vi.mock("@/lib/rate-limit/public", () => ({
  limitPortalMagicLink: async () => ({ allowed: true }),
  limitPractitionerClientEmail: async (input: { action: string }) => {
    state.rateLimited.push(input.action);
    return { allowed: true };
  },
  RATE_LIMIT_MESSAGE: "rate limited",
}));
vi.mock("@/lib/portal/queries", () => ({
  findActiveClientsForPortalLogin: async () => state.matches,
  findActiveClientsForStudioPortalLogin: async () => state.matches,
}));
vi.mock("@/lib/booking/queries", () => ({
  getStudioBySlug: async () => ({ ...state.studio, id: STUDIO_ID }),
}));
vi.mock("@/lib/email/send-appointment", () => ({
  sendEmailSafely: async (m: { to: string }) => {
    state.emails.push(m);
    return { ok: true };
  },
}));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.invalid" }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", active: true },
    studio: { ...state.studio, id: STUDIO_ID },
  }),
}));

const session = await import("@/lib/portal/session");
const { verifyPortalMagicLinkAction } = await import("@/app/portal/verify/[token]/actions");
const { requestPortalMagicLinkAction } = await import("@/app/portal/login/actions");
const { sendPortalLinkAction } = await import("@/app/(app)/clients/[id]/portal-link-actions");
const { createPortalMessageAction } = await import("@/app/(app)/clients/[id]/portal-messages-actions");

const OFF = { client_portal_enabled: false };

function setStudio(flags: Record<string, unknown> = {}) {
  state.studio = { name: "Synthetic Studio", slug: "synthetic-studio", ...flags };
}

beforeEach(() => {
  state.cookie = "raw-session-cookie";
  state.studioReadError = null;
  state.link = {
    id: "link-1",
    studio_id: STUDIO_ID,
    client_id: CLIENT_ID,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    consumed_at: null,
  };
  state.writes.length = 0;
  state.redirects.length = 0;
  state.emails.length = 0;
  state.rateLimited.length = 0;
  state.matches = [{ studioId: STUDIO_ID, clientId: CLIENT_ID }];
  setStudio();
});

describe("the portal session resolver (every portal page and action)", () => {
  it("DEFAULT (no policy column): the session is active, exactly as before", async () => {
    const s = await session.getCurrentPortalSessionState();
    expect(s.kind).toBe("active");
    expect(await session.getCurrentPortalSession()).toMatchObject({ studioId: STUDIO_ID, clientId: CLIENT_ID });
    expect(await session.requirePortalSessionForAction("expired")).toMatchObject({ ok: true });
  });

  it("portal off: a live session resolves to 'disabled', never to a usable session", async () => {
    setStudio(OFF);
    expect(await session.getCurrentPortalSessionState()).toEqual({ kind: "disabled", studioName: "Synthetic Studio" });
    expect(await session.getCurrentPortalSession()).toBeNull();
  });

  it("portal off: actions get the understandable refusal, not 'session expired'", async () => {
    setStudio(OFF);
    const r = await session.requirePortalSessionForAction("Your portal session has expired.");
    expect(r).toEqual({
      ok: false,
      code: "portal_disabled",
      error: expect.stringContaining("Online client access isn't available for Synthetic Studio"),
    });
  });

  it("other flags off do not touch the portal", async () => {
    setStudio({ client_cancellation_enabled: false, client_reschedule_enabled: false });
    expect((await session.getCurrentPortalSessionState()).kind).toBe("active");
  });

  it("an unreadable policy FAILS CLOSED to no session", async () => {
    state.studioReadError = { code: "57014" };
    const silence = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await session.getCurrentPortalSessionState()).toEqual({ kind: "none" });
    silence.mockRestore();
  });

  it("no session is minted for a disabled studio (createPortalSession refuses, writes nothing)", async () => {
    setStudio(OFF);
    await expect(session.createPortalSession({ studioId: STUDIO_ID, clientId: CLIENT_ID })).rejects.toThrow(
      /client portal access is off/,
    );
    expect(state.writes.filter((w) => w.table === "client_portal_sessions")).toEqual([]);
  });
});

describe("magic-link verify", () => {
  function form() {
    const fd = new FormData();
    fd.set("token", "synthetic-magic-token");
    return fd;
  }

  it("DEFAULT: consumes the link, creates the session, and goes to /portal", async () => {
    await expect(verifyPortalMagicLinkAction(form())).rejects.toThrow("REDIRECT:/portal");
    expect(state.writes.map((w) => `${w.table}:${w.op}`)).toEqual([
      "client_portal_magic_links:update",
      "client_portal_sessions:insert",
    ]);
  });

  it("portal off: refuses BEFORE consuming the link and mints no session", async () => {
    setStudio(OFF);
    await expect(verifyPortalMagicLinkAction(form())).rejects.toThrow(
      "REDIRECT:/portal/verify/synthetic-magic-token",
    );
    expect(state.writes).toEqual([]);
  });
});

describe("portal sign-in", () => {
  function form(slug?: string) {
    const fd = new FormData();
    fd.set("email", "client@example.invalid");
    if (slug) fd.set("studio_slug", slug);
    return fd;
  }

  it("DEFAULT: a matched client is sent one magic link", async () => {
    const r = await requestPortalMagicLinkAction(form("synthetic-studio"));
    expect(r.ok).toBe(true);
    expect(state.writes.filter((w) => w.table === "client_portal_magic_links")).toHaveLength(1);
    expect(state.emails).toHaveLength(1);
  });

  it("studio-scoped, portal off: says so (the slug is public), issues nothing", async () => {
    setStudio(OFF);
    const r = await requestPortalMagicLinkAction(form("synthetic-studio"));
    expect(r).toEqual({
      ok: false,
      error: expect.stringContaining("Online client access isn't available for Synthetic Studio"),
    });
    expect(state.writes).toEqual([]);
    expect(state.emails).toEqual([]);
  });

  it("studio-scoped, portal off: the answer is identical whether or not the email is a client", async () => {
    setStudio(OFF);
    const known = await requestPortalMagicLinkAction(form("synthetic-studio"));
    state.matches = [];
    const unknown = await requestPortalMagicLinkAction(form("synthetic-studio"));
    expect(unknown).toEqual(known);
  });

  it("UNSCOPED, portal off: no link, and the SAME generic answer as a non-client", async () => {
    setStudio(OFF);
    const forClient = await requestPortalMagicLinkAction(form());
    state.matches = [];
    const forStranger = await requestPortalMagicLinkAction(form());
    expect(forClient).toEqual(forStranger);
    expect(forClient.ok).toBe(true);
    expect(state.writes).toEqual([]);
    expect(state.emails).toEqual([]);
  }, 10_000);
});

describe("staff actions that would hand a client portal access", () => {
  it("DEFAULT: 'send portal link' proceeds", async () => {
    const fd = new FormData();
    fd.set("client_id", CLIENT_ID);
    await sendPortalLinkAction(fd);
    expect(state.rateLimited).toContain("portal_link");
  });

  it("portal off: 'send portal link' refuses with a staff message, before the rate limiter", async () => {
    setStudio(OFF);
    const fd = new FormData();
    fd.set("client_id", CLIENT_ID);
    const r = await sendPortalLinkAction(fd);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/portal access is turned off/) });
    expect(state.rateLimited).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("portal off: a staff portal message refuses, saves nothing and emails nothing", async () => {
    setStudio(OFF);
    const fd = new FormData();
    fd.set("client_id", CLIENT_ID);
    fd.set("subject", "Synthetic subject");
    fd.set("body", "Synthetic body");
    const r = await createPortalMessageAction(fd);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/portal access is turned off/) });
    expect(state.writes).toEqual([]);
    expect(state.emails).toEqual([]);
  });
});

describe("source contract: no portal entry point can bypass the resolver", () => {
  const root = path.resolve(__dirname, "../../..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = path.join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }

  it("only lib/portal/session.ts resolves a portal session from its token", () => {
    // (lib/portal/queries.ts reads last_seen_at for the STAFF status card; that
    // grants nothing. Resolving a session means matching session_token_hash.)
    const offenders = [...files(path.join(root, "app")), ...files(path.join(root, "lib"))]
      .filter((f) => !f.endsWith(path.join("lib", "portal", "session.ts")))
      .filter((f) => /\.eq\("session_token_hash"/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it("every portal server action resolves the session through the gated resolver", () => {
    const actionFiles = files(path.join(root, "app", "portal")).filter((f) =>
      readFileSync(f, "utf8").startsWith('"use server"'),
    );
    const unauthenticated = new Set(["login/actions.ts", "logout/actions.ts", "verify/[token]/actions.ts"]);
    for (const f of actionFiles) {
      const rel = path.relative(path.join(root, "app", "portal"), f);
      if (unauthenticated.has(rel)) continue;
      const src = readFileSync(f, "utf8");
      const exported = src.split(/(?=export async function )/).slice(1);
      expect(exported.length, rel).toBeGreaterThan(0);
      for (const fn of exported) {
        const name = /export async function (\w+)/.exec(fn)?.[1];
        const direct = /requirePortalSessionForAction\(|getCurrentPortalSession\(/.test(fn);
        // rebook actions resolve through one shared helper.
        const viaHelper = /resolvePortalBookingContext\(/.test(fn);
        expect(direct || viaHelper, `${rel}:${name}`).toBe(true);
      }
    }
  });

  it("/portal and verify render the HON-47 surface for a disabled studio", () => {
    const page = readFileSync(path.join(root, "app", "portal", "page.tsx"), "utf8");
    expect(page).toMatch(/sessionState\.kind === "disabled"[\s\S]{0,120}<PortalAccessDisabled/);
    const verify = readFileSync(path.join(root, "app", "portal", "verify", "[token]", "page.tsx"), "utf8");
    expect(verify).toMatch(/!policy\.policy\.portal[\s\S]{0,80}<PortalAccessDisabled/);
    const login = readFileSync(path.join(root, "app", "portal", "login", "page.tsx"), "utf8");
    expect(login).toMatch(/clientSelfServicePolicyFromStudio\(studio\)\.portal[\s\S]{0,80}<PortalAccessDisabled/);
  });
});
