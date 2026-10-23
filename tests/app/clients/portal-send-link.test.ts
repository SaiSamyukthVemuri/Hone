import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR: practitioner Send/Copy portal link + resend rate-limiting. vitest env is
// "node" (no DOM), and the issuance touches the DB/email transport — so the
// wiring + security invariants are verified by source pins + the email unit
// test (tests/lib/portal/magic-link.test.ts). No real email is sent.
function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}
const ISSUE = read("lib/portal/magic-link.ts");
const ACTION = read("app/(app)/clients/[id]/portal-link-actions.ts");
const CARD = read("app/(app)/clients/[id]/PortalAccessCard.tsx");
const RL = read("lib/rate-limit/public.ts");
const INTAKE = read("app/(app)/clients/[id]/intake/actions.ts");
const MESSAGES = read("app/(app)/clients/[id]/portal-messages-actions.ts");
const PUBLIC_LOGIN = read("app/portal/login/actions.ts");

describe("issuance reuses the secure primitives (hashed, studio-scoped, no raw token log)", () => {
  it("token is HASHED at rest — only token_hash is inserted", () => {
    expect(ISSUE).toMatch(/const tokenHash = hashToken\(rawToken\)/);
    expect(ISSUE).toMatch(/token_hash: tokenHash/);
  });
  it("row is studio-scoped (studio_id + client_id) with a 60-min expiry", () => {
    expect(ISSUE).toMatch(/studio_id: input\.studioId/);
    expect(ISSUE).toMatch(/client_id: input\.clientId/);
    expect(ISSUE).toMatch(/PORTAL_MAGIC_LINK_TTL_MS/);
  });
  it("reuses the existing SAFE portal email (no new template)", () => {
    expect(ISSUE).toMatch(/buildPortalMagicLinkEmail\(\{ studioName, magicLink \}\)/);
  });
  it("the RAW token is only in the emailed URL — never logged", () => {
    // rawToken appears in the magicLink URL construction, but no log statement
    // includes rawToken / magicLink.
    expect(ISSUE).toMatch(/portal\/verify\/\$\{rawToken\}/);
    const logLines = ISSUE.split("\n").filter((l) => /console\.(log|error)/.test(l) || l.includes("event:"));
    for (const l of logLines) {
      expect(l).not.toMatch(/rawToken|magicLink|tokenHash/);
    }
  });
});

describe("practitioner send action: studio-scoped + rate-limited + reuses issuance", () => {
  it("loads the client scoped to the practitioner's studio (no cross-studio send)", () => {
    expect(ACTION).toMatch(/\.eq\("id", clientId\)\s*\n\s*\.eq\("studio_id", studio\.id\)/);
    expect(ACTION).toMatch(/Client not found in your studio/);
  });
  it("is rate-limited before issuing, with friendly copy", () => {
    expect(ACTION).toMatch(/limitPractitionerClientEmail\(\{\s*action: "portal_link"/);
    expect(ACTION).toMatch(/Too many portal links sent to this client recently/);
  });
  it("issues via the shared helper (no bespoke token logic in the action)", () => {
    expect(ACTION).toMatch(/issuePortalMagicLink\(admin, \{/);
    expect(ACTION).not.toMatch(/generateRawToken|hashToken/);
  });
  it("requires a client email", () => {
    expect(ACTION).toMatch(/no email on file/);
  });
});

describe("Copy login URL copies a NON-token studio portal address", () => {
  it("copies the /portal/login?studio=... URL, never a token", () => {
    expect(CARD).toMatch(/navigator\.clipboard\.writeText\(portalLoginUrl\)/);
    // the URL prop is the studio login page (built in page.tsx from the slug)
    expect(CARD).toMatch(/portalLoginUrl: string; \/\/ \/portal\/login\?studio=SLUG/);
    expect(CARD).not.toMatch(/verify\/|rawToken|token_hash/);
  });
});

describe("resend rate limiting added; limiter is 3/hour per practitioner+client", () => {
  it("the limiter is a 3-per-hour sliding window keyed per action+practitioner+client", () => {
    expect(RL).toMatch(/export async function limitPractitionerClientEmail/);
    expect(RL).toMatch(/Ratelimit\.slidingWindow\(3, "1 h"\)/);
    expect(RL).toMatch(/\$\{hashId\(args\.action\)\}:\$\{hashId\(args\.practitionerId\)\}:\$\{hashId\(args\.clientId\)\}/);
  });
  it("intake resend + intake request + portal message are rate-limited", () => {
    expect(INTAKE).toMatch(/limitPractitionerClientEmail\(\{\s*action: "intake_resend"/);
    expect(INTAKE).toMatch(/limitPractitionerClientEmail\(\{\s*action: "intake_request"/);
    expect(MESSAGES).toMatch(/limitPractitionerClientEmail\(\{\s*action: "portal_message"/);
  });
});

describe("public login enumeration safety + flow are UNCHANGED", () => {
  it("the public self-request action still returns a generic (enumeration-safe) success", () => {
    expect(PUBLIC_LOGIN).toMatch(/GENERIC_SUCCESS/);
    expect(PUBLIC_LOGIN).toMatch(/If that email is on file/);
    // the practitioner action does NOT touch the public login file
    expect(ACTION).not.toMatch(/GENERIC_SUCCESS/);
  });
  it("no SMS + no Stripe in the new portal-link surfaces", () => {
    for (const src of [ISSUE, ACTION, CARD]) {
      expect(src).not.toMatch(/twilio|sendSms|stripe/i);
    }
  });
});


const portal = vi.hoisted(() => ({
  identity: vi.fn(), limit: vi.fn(), lookup: vi.fn(), from: vi.fn(), send: vi.fn(), write: vi.fn(),
  filters: [] as Array<[string, unknown]>,
}));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: portal.identity }));
vi.mock("@/lib/rate-limit/public", () => ({ limitPractitionerClientEmail: portal.limit }));
vi.mock("@/lib/email/send-appointment", () => ({ sendEmailSafely: portal.send }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => ({ from: portal.from }) }));
vi.mock("@/lib/email/studio-identity", () => ({ resolveReplyTo: vi.fn(), studioClientContactEmail: vi.fn() }));
vi.mock("@/lib/email/templates/portal-message-notification", () => ({ buildPortalMessageNotificationEmail: vi.fn() }));
vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://hone.example.test" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { createPortalMessageAction } from "@/app/(app)/clients/[id]/portal-messages-actions";

const PORTAL_STUDIO = "11111111-2222-4333-8444-555555555555";
const PORTAL_CLIENT = "22222222-3333-4444-8555-666666666666";
const PORTAL_ACTOR = "33333333-4444-4555-8666-777777777777";
function portalForm() {
  const data = new FormData(); data.set("client_id", PORTAL_CLIENT);
  data.set("subject", "Synthetic subject"); data.set("body", "Synthetic body"); return data;
}
describe("portal-message client lookup log privacy", () => {
  beforeEach(() => {
    vi.clearAllMocks(); portal.filters = [];
    portal.identity.mockResolvedValue({ practitioner: { id: PORTAL_ACTOR, active: true }, studio: { id: PORTAL_STUDIO } });
    portal.limit.mockResolvedValue({ allowed: true });
    portal.send.mockImplementation(() => { throw new Error("Unexpected provider path"); });
    portal.write.mockImplementation(() => { throw new Error("Unexpected write path"); });
    portal.from.mockImplementation((table: string) => {
      expect(table).toBe("clients");
      const q = {
        select: () => q,
        eq: (key: string, value: unknown) => { portal.filters.push([key, value]); return q; },
        maybeSingle: portal.lookup, insert: portal.write, update: portal.write,
      };
      return q;
    });
  });
  afterEach(() => vi.restoreAllMocks());
  it("omits database free text and retains the same scoped lookup failure without writing or sending", async () => {
    portal.lookup.mockResolvedValue({ data: null, error: { code: "57014", message: `synthetic-patient@example.test clinical-sentinel synthetic-token ${PORTAL_CLIENT}` } });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(createPortalMessageAction(portalForm())).resolves.toEqual({ ok: false, error: "Couldn't load client. Please try again." });
    expect(portal.identity).toHaveBeenCalledOnce();
    expect(portal.limit).toHaveBeenCalledExactlyOnceWith({ action: "portal_message", practitionerId: PORTAL_ACTOR, clientId: PORTAL_CLIENT });
    expect(portal.filters).toEqual([["id", PORTAL_CLIENT], ["studio_id", PORTAL_STUDIO]]);
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(log.mock.calls[0]![0]));
    expect(payload).toEqual({ event: "portal_message_client_lookup_failed", code: "57014", timestamp: expect.any(String) });
    expect(Number.isNaN(Date.parse(payload.timestamp))).toBe(false);
    for (const text of ["synthetic-patient", "clinical-sentinel", "synthetic-token", PORTAL_CLIENT]) expect(JSON.stringify(log.mock.calls)).not.toContain(text);
    expect(portal.write).not.toHaveBeenCalled(); expect(portal.send).not.toHaveBeenCalled();
  });
  it("keeps a missing client refused without writing or sending", async () => {
    portal.lookup.mockResolvedValue({ data: null, error: null });
    await expect(createPortalMessageAction(portalForm())).resolves.toEqual({ ok: false, error: "Client not found." });
    expect(portal.filters).toEqual([["id", PORTAL_CLIENT], ["studio_id", PORTAL_STUDIO]]);
    expect(portal.write).not.toHaveBeenCalled(); expect(portal.send).not.toHaveBeenCalled();
  });
  it.each(["inactive", "rate-limited"])("keeps %s refusal ahead of client reads", async (mode) => {
    if (mode === "inactive") portal.identity.mockResolvedValue({ practitioner: { id: PORTAL_ACTOR, active: false }, studio: { id: PORTAL_STUDIO } });
    else portal.limit.mockResolvedValue({ allowed: false });
    await expect(createPortalMessageAction(portalForm())).resolves.toEqual({ ok: false, error: mode === "inactive"
      ? "Inactive practitioners cannot send messages." : "Too many messages sent to this client recently. Please try again later." });
    expect(portal.from).not.toHaveBeenCalled(); expect(portal.write).not.toHaveBeenCalled(); expect(portal.send).not.toHaveBeenCalled();
  });
});
