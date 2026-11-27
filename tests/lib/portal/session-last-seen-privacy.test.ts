import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { destroyPortalSession, getCurrentPortalSessionState, getCurrentPortalSession, requirePortalSessionForAction } from "@/lib/portal/session";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), get: vi.fn(), hash: vi.fn(), set: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.get, set: mocks.set }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/portal/tokens", () => ({ generateRawToken: vi.fn(), hashToken: mocks.hash }));

const row = {
  id: "8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  studio_id: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  client_id: "7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: null,
  client: { id: "7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5", studio_id: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5", archived_at: null },
};
const secretText = `session ${row.id} client ${row.client_id} patient@example.test raw-cookie-secret token-hash-secret`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ value: "raw-cookie-secret" });
  mocks.hash.mockReturnValue("token-hash-secret");
});
afterEach(() => vi.restoreAllMocks());

function fixture(mode: "error" | "reject" | "ok", sessionRow: Record<string, unknown> = row) {
  let settled: Promise<unknown> | undefined;
  const update = vi.fn();
  const updateEq = vi.fn();
  const selectEq = vi.fn(() => ({ maybeSingle: async () => ({ data: sessionRow, error: null }) }));
  update.mockReturnValue({ eq: updateEq });
  updateEq.mockReturnValue({ then: (yes: (value: unknown) => unknown, no: (error: unknown) => unknown) => {
    const response = mode === "reject" ? Promise.reject(new Error(secretText)) : Promise.resolve({ error: mode === "error" ? { code: "23503", message: secretText } : null });
    settled = response.then(yes, no);
    return settled;
  } });
  mocks.admin.mockReturnValue({ from: () => ({ select: () => ({ eq: selectEq }), update }) });
  return { update, updateEq, selectEq, settle: () => settled };
}

async function lookup(mode: "error" | "reject" | "ok") {
  const db = fixture(mode);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await getCurrentPortalSession()).toEqual({ id: row.id, studioId: row.studio_id, clientId: row.client_id, expiresAt: row.expires_at });
  await db.settle();
  expect(db.selectEq).toHaveBeenCalledWith("session_token_hash", "token-hash-secret");
  expect(db.update).toHaveBeenCalledWith({ last_seen_at: expect.any(String) });
  expect(db.updateEq).toHaveBeenCalledWith("id", row.id);
  return log;
}

describe("portal last-seen failures disclose only operational markers", () => {
  it.each([
    ["archived", { ...row, client: { ...row.client, archived_at: "2026-01-02T12:00:00Z" } }],
    ["removed", { ...row, client: null }],
    ["moved to a different studio", { ...row, client: { ...row.client, studio_id: "other" } }],
    ["different client", { ...row, client: { ...row.client, id: "other" } }],
    ["revoked", { ...row, revoked_at: "2026-01-02T12:00:00Z" }],
    ["expired", { ...row, expires_at: "2020-01-02T12:00:00Z" }],
  ] as const)("refuses %s sessions for both login and portal actions before touching last_seen", async (_reason, sessionRow) => {
    const db = fixture("ok", sessionRow);
    expect(await getCurrentPortalSessionState()).toEqual({ kind: "none" });
    expect(await getCurrentPortalSession()).toBeNull();
    expect(await requirePortalSessionForAction("Sign in")).toEqual({ ok: false, code: "session_expired", error: "Sign in" });
    expect(db.update).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("checking a link against a current session is read-only", async () => {
    const db = fixture("ok");
    const session = await getCurrentPortalSessionState({ recordVisit: false });
    expect(session.kind).toBe("active");
    expect(db.update).not.toHaveBeenCalled();
  });
  it.each(["error", "reject"] as const)("withholds identifiers and free text on %s without denying the session", async (mode) => {
    const log = await lookup(mode);
    expect(log).toHaveBeenCalledOnce();
    const event = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(event).toMatchObject({ event: "portal_session_last_seen_update_failed", timestamp: expect.any(String) });
    expect(Object.keys(event).sort()).toEqual(mode === "error" ? ["code", "event", "timestamp"] : ["event", "timestamp"]);
    if (mode === "error") expect(event.code).toBe("23503");
    for (const privateText of [row.id, row.client_id, row.studio_id, "patient@example.test", "raw-cookie-secret", "token-hash-secret"]) {
      expect(JSON.stringify(event)).not.toContain(privateText);
    }
  });

  it("keeps successful last-seen writes silent", async () => {
    expect(await lookup("ok")).not.toHaveBeenCalled();
  });
});


describe("portal lookup/logout diagnostics omit free-form provider text", () => {
  function expectMarker(log: ReturnType<typeof vi.spyOn>, event: string) {
    expect(log).toHaveBeenCalledOnce();
    const entry = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(entry).toEqual({ event, code: "42P01", timestamp: expect.any(String) });
  }

  it("lookup errors stay anonymous and do not publish the error payload", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: null, error: { code: "42P01", message: secretText } }) }));
    mocks.admin.mockReturnValue({ from: () => ({ select: () => ({ eq }) }) });
    expect(await getCurrentPortalSession()).toBeNull();
    expect(eq).toHaveBeenCalledWith("session_token_hash", "token-hash-secret");
    expectMarker(log, "portal_session_lookup_failed");
  });

  it("a temporarily unreadable session declines actions, retains the cookie, and succeeds on retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reject = vi.fn(async () => { throw new Error("unavailable"); });
    mocks.admin.mockReturnValue({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: reject }) }) }) });
    expect(await getCurrentPortalSessionState()).toEqual({ kind: "unavailable" });
    expect(await requirePortalSessionForAction("Sign in")).toMatchObject({ ok: false, code: "unavailable" });
    expect(mocks.set).not.toHaveBeenCalled();
    fixture("ok");
    expect((await getCurrentPortalSessionState({ recordVisit: false })).kind).toBe("active");
  });

  it("revocation errors still clear the cookie without publishing error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const eq = vi.fn(() => ({ is: async () => ({ error: { code: "42P01", message: secretText } }) }));
    mocks.admin.mockReturnValue({ from: () => ({ update: () => ({ eq }) }) });
    await destroyPortalSession();
    expect(eq).toHaveBeenCalledWith("session_token_hash", "token-hash-secret");
    expect(mocks.set).toHaveBeenCalledWith(expect.objectContaining({ name: "hone_portal_session", value: "", expires: new Date(0), httpOnly: true }));
    expectMarker(log, "portal_session_revoke_failed");
  });
});


describe("an existing portal session after studio-managed mode is enabled", () => {
  it("does not return client access even though the cookie and session remain valid, and leaves no last-seen trace", async () => {
    const update = vi.fn(() => ({ eq: () => ({ then: (done: (x: unknown) => void) => done({ error: null }) }) }));
    mocks.admin.mockReturnValue({
      from: (table: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: table === "studios" ? { id: row.studio_id, name: "Synthetic Studio", studio_managed_appointments: true } : row, error: null }) }) }),
        update,
      }),
    });
    expect(await getCurrentPortalSession()).toBeNull();
    // A refused session is not stamped as seen (the touch runs only for a session that is used).
    expect(update).not.toHaveBeenCalled();
  });
});
