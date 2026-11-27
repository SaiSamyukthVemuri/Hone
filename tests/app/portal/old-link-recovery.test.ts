import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/portal/tokens";

const TOKEN = "a".repeat(43);
const ADDRESS = "registered@example.test";
const PREVIOUS_ADDRESS = "previous@example.test";
const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";
type Row = Record<string, string | null>;
const t = vi.hoisted(() => ({
  rows: {} as Record<string, Row[]>,
  session: { kind: "none" } as { kind: string; session?: { studioId: string; clientId: string } },
  state: vi.fn(),
  ip: vi.fn(),
  recipient: vi.fn(),
  send: vi.fn(),
  createSession: vi.fn(),
  access: vi.fn(),
  sleep: vi.fn(),
  reads: [] as string[],
  writes: [] as { table: string; row: Row }[],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error("redirect " + url); } }));
vi.mock("@/app/_components/MarketingFooter", () => ({ MarketingFooter: () => null }));
vi.mock("@/lib/portal/access-events", () => ({ logPortalAccessEvent: async () => undefined }));
vi.mock("@/lib/portal/session", () => ({
  getCurrentPortalSessionState: t.state,
  createPortalSession: t.createSession,
}));
vi.mock("@/lib/portal/login-timing", () => ({ waitUntilMinimumElapsed: t.sleep }));
vi.mock("@/lib/rate-limit/public", () => ({ limitPortalLinkIp: t.ip, limitPortalLinkRecipient: t.recipient }));
vi.mock("@/lib/portal/portal-access-gate", () => ({ studioPortalAccess: t.access }));
vi.mock("@/lib/email/send-appointment", () => ({ sendEmailSafely: t.send }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://preview.example.test" }));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let rows = [...(t.rows[table] ?? [])];
      let change: Row | undefined;
      const q = {
        select: () => {
          if (change) {
            for (const row of rows) Object.assign(row, change);
            return { data: rows, error: null };
          }
          return q;
        },
        eq: (key: string, value: string) => { rows = rows.filter(row => row[key] === value); return q; },
        is: (key: string, value: null) => { rows = rows.filter(row => row[key] === value); return q; },
        gt: (key: string, value: string) => { rows = rows.filter(row => Date.parse(row[key]!) > Date.parse(value)); return q; },
        maybeSingle: () => {
          t.reads.push(table);
          return { data: rows[0] ?? null, error: null };
        },
        insert: (row: Row) => { t.writes.push({ table, row }); return { error: null }; },
        update: (patch: Row) => { change = patch; return q; },
      };
      return q;
    },
  }),
}));
import VerifyPage from "@/app/portal/verify/[token]/page";
import { requestReplacementPortalLink, verifyPortalMagicLinkAction } from "@/app/portal/verify/[token]/actions";

function form(token = TOKEN) {
  const data = new FormData();
  data.set("token", token);
  // Browser-supplied identity and address must never select a recipient.
  data.set("email", "unrelated@example.test");
  data.set("studio_id", "other-studio");
  data.set("client_id", "other-client");
  return data;
}
const page = async (token = TOKEN) => renderToStaticMarkup(await VerifyPage({ params: Promise.resolve({ token }) }));
const recover = (token = TOKEN) => requestReplacementPortalLink("ready", form(token));
function session(studioId: string, clientId: string) {
  t.session = { kind: "active", session: { studioId, clientId } };
}
function link() { return t.rows.client_portal_magic_links[0]; }
beforeEach(() => {
  vi.resetAllMocks();
  t.session = { kind: "none" };
  t.rows = {
    client_portal_magic_links: [{
      id: "link", token_hash: hashToken(TOKEN), studio_id: "studio", client_id: "client",
      email_normalized: ADDRESS, expires_at: PAST, consumed_at: null,
    }],
    clients: [{ id: "client", studio_id: "studio", normalized_email: ADDRESS, archived_at: null }],
  };
  t.reads = [];
  t.writes = [];
  t.state.mockImplementation(async () => t.session);
  t.ip.mockResolvedValue({ allowed: true });
  t.recipient.mockResolvedValue({ allowed: true });
  t.access.mockResolvedValue({ allowed: true, studioName: "Synthetic Studio" });
  t.send.mockResolvedValue({ ok: true });
});

describe("the original emailed link", () => {
  it.each(["expired", "consumed", "fresh"])("enters with the same active session and %s link, without consuming or emailing", async (kind) => {
    if (kind !== "expired") link().expires_at = FUTURE;
    if (kind === "consumed") link().consumed_at = PAST;
    session("studio", "client");
    await expect(page()).rejects.toThrow("redirect /portal");
    expect(t.state).toHaveBeenCalledWith({ recordVisit: false });
    expect(t.send).not.toHaveBeenCalled();
    expect(t.createSession).not.toHaveBeenCalled();
    expect(link().consumed_at).toBe(kind === "consumed" ? PAST : null);
  });
  it.each([["other-studio", "client"], ["studio", "other-client"]])("never enters an unrelated session (%s, %s)", async (studio, client) => {
    session(studio, client);
    expect(await page()).toContain("Email me a new link");
    expect(t.send).not.toHaveBeenCalled();
  });
  it("revoked/absent session, consumed link and unknown link all receive the same recovery screen", async () => {
    const expired = await page();
    link().consumed_at = PAST;
    expect(await page()).toBe(expired);
    t.rows.client_portal_magic_links = [];
    expect(await page()).toBe(expired);
    expect(expired).not.toMatch(/type="email"|has expired|\/portal\/login|registered@example/);
    expect(t.writes).toEqual([]);
  });
  it("requires a live studio and an active client even when the session identifiers match", async () => {
    session("studio", "client");
    t.session = { kind: "disabled" };
    expect(await page()).toContain("Email me a new link");
    session("studio", "client");
    t.rows.clients[0].archived_at = PAST;
    expect(await page()).toContain("Email me a new link");
    expect(t.createSession).not.toHaveBeenCalled();
  });
  it("keeps a fresh link scanner-safe, then consumes it once on explicit Continue", async () => {
    link().expires_at = FUTURE;
    expect(await page()).toContain("Continue to portal");
    expect(link().consumed_at).toBeNull();
    expect(t.send).not.toHaveBeenCalled();
    await expect(verifyPortalMagicLinkAction(form())).rejects.toThrow(/^redirect \/portal$/);
    await expect(verifyPortalMagicLinkAction(form())).rejects.toThrow("redirect /portal/verify/");
    expect(t.createSession).toHaveBeenCalledTimes(1);
  });
  it("takes a fresh proof issued to a previous email through recovery, including a direct Continue POST", async () => {
    link().expires_at = FUTURE;
    link().email_normalized = PREVIOUS_ADDRESS;
    expect(await page()).toContain("Email me a new link");
    await expect(verifyPortalMagicLinkAction(form())).rejects.toThrow("redirect /portal/verify/");
    expect(link().consumed_at).toBeNull();
    expect(t.createSession).not.toHaveBeenCalled();
  });
});

describe("one-button recovery", () => {
  it("mails a fresh one-time link to the current registered mailbox and creates no session", async () => {
    link().consumed_at = PAST;
    link().email_normalized = PREVIOUS_ADDRESS;
    expect(await recover()).toBe("requested");
    expect(t.recipient).toHaveBeenCalledWith(ADDRESS);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith(expect.objectContaining({ to: ADDRESS }));
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0].row).toMatchObject({ studio_id: "studio", client_id: "client", email_normalized: ADDRESS });
    expect(t.writes[0].row.token_hash).not.toBe(link().token_hash);
    expect(t.createSession).not.toHaveBeenCalled();
    expect(link().consumed_at).toBe(PAST);
  });
  it.each(["unknown", "archived", "other-studio", "no-email", "disabled", "unreadable", "recipient-limited"])("gives the same result and sends nothing for %s", async (kind) => {
    if (kind === "unknown") t.rows.client_portal_magic_links = [];
    if (kind === "archived") t.rows.clients[0].archived_at = PAST;
    if (kind === "other-studio") t.rows.clients[0].studio_id = "other-studio";
    if (kind === "no-email") t.rows.clients[0].normalized_email = null;
    if (kind === "disabled" || kind === "unreadable") t.access.mockResolvedValue({ allowed: false, studioName: null });
    if (kind === "recipient-limited") t.recipient.mockResolvedValue({ allowed: false });
    expect(await recover()).toBe("requested");
    expect(t.writes).toEqual([]);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.sleep).toHaveBeenCalledOnce();
  });
  it("limits requests by IP before any lookup, even for an unknown token", async () => {
    t.ip.mockResolvedValue({ allowed: false });
    expect(await recover()).toBe("limited");
    expect(t.reads).toEqual([]);
    expect(t.recipient).not.toHaveBeenCalled();
    expect(t.send).not.toHaveBeenCalled();
  });
});
