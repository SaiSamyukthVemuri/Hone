import { describe, expect, it } from "vitest";
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
