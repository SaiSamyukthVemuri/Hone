import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCurrentPortalSession } from "@/lib/portal/session";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), get: vi.fn(), hash: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: mocks.get }) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: mocks.admin }));
vi.mock("@/lib/portal/tokens", () => ({ generateRawToken: vi.fn(), hashToken: mocks.hash }));

const row = {
  id: "8f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  studio_id: "6f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  client_id: "7f1c2d3e-4a5b-4c6d-8e7f-90a1b2c3d4e5",
  expires_at: "2099-01-01T00:00:00.000Z",
  revoked_at: null,
};
const secretText = `session ${row.id} client ${row.client_id} patient@example.test raw-cookie-secret token-hash-secret`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockReturnValue({ value: "raw-cookie-secret" });
  mocks.hash.mockReturnValue("token-hash-secret");
});
afterEach(() => vi.restoreAllMocks());

function fixture(mode: "error" | "reject" | "ok") {
  let settled: Promise<unknown> | undefined;
  const update = vi.fn();
  const updateEq = vi.fn();
  const selectEq = vi.fn(() => ({ maybeSingle: async () => ({ data: row, error: null }) }));
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
