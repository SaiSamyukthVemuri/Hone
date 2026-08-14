import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { logPortalAccessEvent } from "@/lib/portal/access-events";
import { computePortalPendingTasks } from "@/lib/portal/pending-tasks";

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
}

// ---- logPortalAccessEvent: allowlist + fail-soft, never leaks -------------
function fakeAdmin(capture: { row?: Record<string, unknown> }, behavior: "ok" | "error" | "throw" = "ok") {
  return {
    from: (_t: string) => ({
      insert: async (row: Record<string, unknown>) => {
        capture.row = row;
        if (behavior === "throw") throw new Error("boom");
        return { error: behavior === "error" ? { code: "42P01" } : null };
      },
    }),
  };
}

describe("logPortalAccessEvent: safe fields only, metadata allowlist, fail-soft", () => {
  it("inserts only ids + event_type + channel + allowlisted metadata", async () => {
    const cap: { row?: Record<string, unknown> } = {};
    await logPortalAccessEvent(fakeAdmin(cap), {
      studioId: "s1",
      clientId: "c1",
      practitionerId: "p1",
      eventType: "portal_link_sent",
      channel: "email",
      // hostile metadata: only retry_after_seconds should survive
      metadata: { retry_after_seconds: 30, token: "RAWSECRET", email: "a@b.com", note: "clinical" } as Record<string, unknown>,
    });
    const row = cap.row!;
    expect(row.studio_id).toBe("s1");
    expect(row.client_id).toBe("c1");
    expect(row.event_type).toBe("portal_link_sent");
    expect(row.channel).toBe("email");
    expect(row.metadata).toEqual({ retry_after_seconds: 30 });
    // never persists a token / email / clinical note
    const blob = JSON.stringify(row).toLowerCase();
    expect(blob).not.toContain("rawsecret");
    expect(blob).not.toContain("a@b.com");
    expect(blob).not.toContain("clinical");
  });
  it("is fail-soft: never throws when the insert errors (incl. pre-migration table-missing)", async () => {
    await expect(
      logPortalAccessEvent(fakeAdmin({}, "error"), { studioId: "s", clientId: "c", eventType: "portal_magic_link_consumed" }),
    ).resolves.toBeUndefined();
  });
  it("is fail-soft: never throws when the insert throws", async () => {
    await expect(
      logPortalAccessEvent(fakeAdmin({}, "throw"), { studioId: "s", clientId: "c", eventType: "portal_session_seen" }),
    ).resolves.toBeUndefined();
  });
});

// ---- computePortalPendingTasks: accuracy ----------------------------------
describe("computePortalPendingTasks: accurate quick status", () => {
  const templates = [{ id: "t1", version: 2, status: "active" }, { id: "t2", version: 1, status: "active" }];
  it("intake in_progress → incomplete; submitted/reviewed → complete", () => {
    expect(computePortalPendingTasks({ intakeStatus: "in_progress", activeConsentTemplates: [], latestSignatures: [], portalMessages: [] }).intakeIncomplete).toBe(true);
    expect(computePortalPendingTasks({ intakeStatus: "submitted", activeConsentTemplates: [], latestSignatures: [], portalMessages: [] }).intakeIncomplete).toBe(false);
    expect(computePortalPendingTasks({ intakeStatus: "reviewed", activeConsentTemplates: [], latestSignatures: [], portalMessages: [] }).intakeIncomplete).toBe(false);
  });
  it("consent count covers missing (unsigned) AND outdated (old version)", () => {
    // t1 signed at current v2 (satisfied); t2 unsigned (missing) → count 1
    let r = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: templates, latestSignatures: [{ template_id: "t1", template_version: 2 }], portalMessages: [] });
    expect(r.consentToSignCount).toBe(1);
    // t1 signed at OLD v1 (outdated) + t2 unsigned → count 2
    r = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: templates, latestSignatures: [{ template_id: "t1", template_version: 1 }], portalMessages: [] });
    expect(r.consentToSignCount).toBe(2);
    // both signed at current → 0
    r = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: templates, latestSignatures: [{ template_id: "t1", template_version: 2 }, { template_id: "t2", template_version: 1 }], portalMessages: [] });
    expect(r.consentToSignCount).toBe(0);
  });
  it("unread messages = published + not reviewed + not archived", () => {
    const msgs = [
      { status: "published", client_reviewed_at: null, archived_at: null }, // unread
      { status: "published", client_reviewed_at: "2026-01-01", archived_at: null }, // read
      { status: "published", client_reviewed_at: null, archived_at: "2026-01-01" }, // archived
      { status: "draft", client_reviewed_at: null, archived_at: null }, // not published
    ];
    const r = computePortalPendingTasks({ intakeStatus: null, activeConsentTemplates: [], latestSignatures: [], portalMessages: msgs });
    expect(r.unreadMessageCount).toBe(1);
  });
  it("hasAny reflects any pending item", () => {
    expect(computePortalPendingTasks({ intakeStatus: "reviewed", activeConsentTemplates: [], latestSignatures: [], portalMessages: [] }).hasAny).toBe(false);
    expect(computePortalPendingTasks({ intakeStatus: "in_progress", activeConsentTemplates: [], latestSignatures: [], portalMessages: [] }).hasAny).toBe(true);
  });
});

// ---- wiring source-pins ---------------------------------------------------
describe("event logging wired at safe points; enumeration path untouched", () => {
  const SEND = read("app/(app)/clients/[id]/portal-link-actions.ts");
  const VERIFY = read("app/portal/verify/[token]/actions.ts");
  const CARD = read("app/(app)/clients/[id]/PortalAccessCard.tsx");
  const LOGIN = read("app/portal/login/actions.ts");
  const HELPER = read("lib/portal/access-events.ts");

  it("practitioner send logs portal_link_sent (success) + portal_link_rate_limited (throttle)", () => {
    expect(SEND).toMatch(/eventType: "portal_link_sent"/);
    expect(SEND).toMatch(/eventType: "portal_link_rate_limited"/);
  });
  it("portal verify logs portal_magic_link_consumed after a successful consume", () => {
    expect(VERIFY).toMatch(/eventType: "portal_magic_link_consumed"/);
    // the log CALL passes only ids + the event type, never the token.
    const start = VERIFY.indexOf("logPortalAccessEvent(admin");
    const call = VERIFY.slice(start, VERIFY.indexOf("});", start));
    expect(call).toMatch(/studioId: link\.studio_id/);
    expect(call).toMatch(/clientId: link\.client_id/);
    expect(call).not.toMatch(/token/i);
  });
  it("the helper's INSERT payload has only safe fields (no token/url/ip/email)", () => {
    expect(HELPER).toMatch(/\.from\("client_portal_access_events"\)/);
    const start = HELPER.indexOf(".insert({");
    const payload = HELPER.slice(start, HELPER.indexOf("});", start));
    expect(payload).toMatch(/studio_id: input\.studioId/);
    expect(payload).not.toMatch(/token|email|ip_|user_agent|url|magic/i);
  });
  it("the card surfaces pending tasks + recent activity", () => {
    expect(CARD).toMatch(/Pending portal tasks/);
    expect(CARD).toMatch(/Recent activity/);
    expect(CARD).toMatch(/EVENT_LABELS/);
  });
  it("public login self-request is UNCHANGED (enumeration safe; no event logging added there)", () => {
    expect(LOGIN).toMatch(/GENERIC_SUCCESS/);
    expect(LOGIN).toMatch(/If that email is on file/);
    expect(LOGIN).not.toMatch(/logPortalAccessEvent/);
  });
});
