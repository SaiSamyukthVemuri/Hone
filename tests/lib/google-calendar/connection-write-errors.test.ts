import { beforeEach, describe, expect, it, vi } from "vitest";

// Supabase returns { data: null, error } instead of throwing, so a failed WRITE looked like success. These pin the real error
// shape ({ error }) for each connection-store write: it must surface (throw ConnectionWriteError, or a closed result) and never be
// reported as success, and a failed read must not lead to a "connected" row without a verified token.

type Res = { data: unknown; error: unknown };
const h = vi.hoisted(() => ({
  ops: [] as Array<{ table: string; op: string; payload?: unknown }>,
  script: {} as Record<string, Res[]>,
}));

function next(key: string): Res {
  const q = h.script[key];
  return q && q.length > 0 ? (q.length > 1 ? q.shift()! : q[0]) : { data: null, error: null };
}

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      let op = "select";
      const b: Record<string, unknown> = {};
      const record = (o: string, payload?: unknown) => {
        op = o;
        h.ops.push({ table, op: o, payload });
        return b;
      };
      b.select = () => (op === "select" ? record("select") : b);
      b.upsert = (p: unknown) => record("upsert", p);
      b.update = (p: unknown) => record("update", p);
      b.delete = () => record("delete");
      b.eq = () => b;
      b.neq = () => b;
      b.maybeSingle = () => Promise.resolve(next(`${table}.${op}`));
      b.then = (resolve: (v: Res) => unknown) => resolve(next(`${table}.${op}`));
      return b;
    },
  }),
}));

import {
  designateStudioCalendarOwner,
  disconnectConnection,
  markReconnectRequired,
  persistConnectedFromCallback,
  setWriteCalendar,
  storeRotatedRefreshToken,
} from "@/lib/google-calendar/connection";
import { ConnectionWriteError } from "@/lib/google-calendar/store-write-error";

const DB_ERR = { message: "boom", code: "XX000" };
const INPUT = {
  studioId: "s1",
  practitionerId: "p1",
  googleAccountId: "g1",
  googleAccountEmail: null,
  grantedScopes: ["x"],
  tokenExpiresAt: "2026-01-01T00:00:00Z",
  writeCalendarId: null,
  encryptedRefreshToken: null as string | null,
  refreshTokenLast4: null,
  encryptionKeyVersion: 1,
};
const writes = (table?: string) => h.ops.filter((o) => o.op !== "select" && (!table || o.table === table));

beforeEach(() => {
  h.ops = [];
  h.script = {};
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(console.error).mockClear();
});

describe("storeRotatedRefreshToken", () => {
  const args = { connectionId: "c1", studioId: "s1", encryptedRefreshToken: "e", refreshTokenLast4: "1234", encryptionKeyVersion: 1 };
  it("throws store_rotated_token on a returned error", async () => {
    h.script["calendar_connection_secrets.update"] = [{ data: null, error: DB_ERR }];
    await expect(storeRotatedRefreshToken(args)).rejects.toMatchObject({ step: "store_rotated_token" });
  });
  it("throws store_rotated_token_no_row when zero rows were updated (no error)", async () => {
    h.script["calendar_connection_secrets.update"] = [{ data: [], error: null }];
    await expect(storeRotatedRefreshToken(args)).rejects.toMatchObject({ step: "store_rotated_token_no_row" });
  });
  it("resolves when a row was updated", async () => {
    h.script["calendar_connection_secrets.update"] = [{ data: [{ connection_id: "c1" }], error: null }];
    await expect(storeRotatedRefreshToken(args)).resolves.toBeUndefined();
  });
});

describe("markReconnectRequired / setWriteCalendar", () => {
  it("markReconnectRequired throws mark_reconnect_required on a returned error", async () => {
    h.script["calendar_connections.update"] = [{ data: null, error: DB_ERR }];
    await expect(markReconnectRequired("s1", "p1", "invalid_grant")).rejects.toBeInstanceOf(ConnectionWriteError);
  });
  it("setWriteCalendar throws set_write_calendar on a returned error", async () => {
    h.script["calendar_connections.update"] = [{ data: null, error: DB_ERR }];
    await expect(setWriteCalendar("s1", "p1", "cal")).rejects.toMatchObject({ step: "set_write_calendar" });
  });
  it("both resolve on success", async () => {
    await expect(markReconnectRequired("s1", "p1", "x")).resolves.toBeUndefined();
    await expect(setWriteCalendar("s1", "p1", "cal")).resolves.toBeUndefined();
  });
});

describe("designateStudioCalendarOwner (N-2)", () => {
  it("a failed clear-others stops BEFORE setting the new owner, returns false, logs a fixed string", async () => {
    h.script["calendar_connections.update"] = [{ data: null, error: DB_ERR }];
    expect(await designateStudioCalendarOwner("s1", "p1")).toBe(false);
    expect(writes("calendar_connections")).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("google_calendar_error:designate_owner:clear_others");
  });
  it("a failed set-owner returns false and logs a fixed string", async () => {
    h.script["calendar_connections.update"] = [{ data: null, error: null }, { data: null, error: DB_ERR }];
    expect(await designateStudioCalendarOwner("s1", "p1")).toBe(false);
    expect(console.error).toHaveBeenCalledWith("google_calendar_error:designate_owner:set_owner");
  });
  it("both succeed: true", async () => {
    expect(await designateStudioCalendarOwner("s1", "p1")).toBe(true);
    expect(writes("calendar_connections")).toHaveLength(2);
  });
});

describe("persistConnectedFromCallback (P-1): no token returned", () => {
  it("a failed secret READ writes nothing and reports secret_read_failed (no 'connected' row)", async () => {
    h.script["calendar_connections.select"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.select"] = [{ data: null, error: DB_ERR }];
    const r = await persistConnectedFromCallback(INPUT);
    expect(r).toEqual({ ok: false, reason: "secret_read_failed" });
    expect(writes()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith("google_calendar_error:oauth_persist:read_secret");
  });
  it("a failed connection READ writes nothing and reports connection_read_failed", async () => {
    h.script["calendar_connections.select"] = [{ data: null, error: DB_ERR }];
    expect(await persistConnectedFromCallback(INPUT)).toEqual({ ok: false, reason: "connection_read_failed" });
    expect(writes()).toEqual([]);
  });
  it("an existing token is preserved: upsert is 'connected'", async () => {
    h.script["calendar_connections.select"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.select"] = [{ data: { encrypted_refresh_token: "e" }, error: null }];
    h.script["calendar_connections.upsert"] = [{ data: { id: "c1" }, error: null }];
    expect(await persistConnectedFromCallback(INPUT)).toEqual({ ok: true, connectionId: "c1" });
    expect((writes("calendar_connections")[0].payload as { connection_status: string }).connection_status).toBe("connected");
  });
  it("no existing token: the single upsert is reconnect_required (never connected), result no_refresh_token", async () => {
    h.script["calendar_connections.select"] = [{ data: null, error: null }];
    h.script["calendar_connections.upsert"] = [{ data: { id: "c9" }, error: null }];
    expect(await persistConnectedFromCallback(INPUT)).toEqual({ ok: false, reason: "no_refresh_token" });
    const payloads = writes("calendar_connections").map((w) => (w.payload as { connection_status: string }).connection_status);
    expect(payloads).toEqual(["reconnect_required"]);
  });
  it("a new token: upsert is connected, then the secret is upserted; a secret-upsert error is reported", async () => {
    h.script["calendar_connections.upsert"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.upsert"] = [{ data: null, error: DB_ERR }];
    expect(await persistConnectedFromCallback({ ...INPUT, encryptedRefreshToken: "enc", refreshTokenLast4: "1234" })).toEqual({ ok: false, reason: "secret_upsert_failed" });
  });
  it("Q-2: a secret-upsert error leaves the ROW reconnect_required (not connected), with fixed log strings and no error object", async () => {
    h.script["calendar_connections.upsert"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.upsert"] = [{ data: null, error: DB_ERR }];
    expect(await persistConnectedFromCallback({ ...INPUT, encryptedRefreshToken: "enc", refreshTokenLast4: "1234" })).toEqual({ ok: false, reason: "secret_upsert_failed" });
    const statuses = writes("calendar_connections").map((w) => (w.payload as { connection_status: string }).connection_status);
    expect(statuses).toEqual(["connected", "reconnect_required"]);
    const demote = writes("calendar_connections").find((w) => w.op === "update")!.payload as { last_error_code: string };
    expect(demote.last_error_code).toBe("secret_store_failed");
    // O-2: the log argument is a fixed string, never an id, message or error object.
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.map((c) => c.length)).toEqual(calls.map(() => 1));
    expect(calls.map((c) => c[0])).toEqual(["google_calendar_error:oauth_persist:store_secret"]);
  });
  it("Q-2: if the demotion write also fails it is logged and the caller still gets secret_upsert_failed", async () => {
    h.script["calendar_connections.upsert"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.upsert"] = [{ data: null, error: DB_ERR }];
    h.script["calendar_connections.update"] = [{ data: null, error: DB_ERR }];
    expect(await persistConnectedFromCallback({ ...INPUT, encryptedRefreshToken: "enc", refreshTokenLast4: "1234" })).toEqual({ ok: false, reason: "secret_upsert_failed" });
    const calls = (console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["google_calendar_error:oauth_persist:store_secret", "google_calendar_error:oauth_persist:demote_after_secret_failure"]);
  });
  it("Q-1: a failed secret delete throws disconnect_delete_secret and the connection row is NOT marked disconnected", async () => {
    h.script["calendar_connections.select"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connection_secrets.delete"] = [{ data: null, error: DB_ERR }];
    await expect(disconnectConnection("s1", "p1")).rejects.toMatchObject({ step: "disconnect_delete_secret" });
    expect(writes("calendar_connections")).toEqual([]);
  });
  it("Q-1: a failed mark-disconnected throws disconnect_mark_disconnected", async () => {
    h.script["calendar_connections.select"] = [{ data: { id: "c1" }, error: null }];
    h.script["calendar_connections.update"] = [{ data: null, error: DB_ERR }];
    await expect(disconnectConnection("s1", "p1")).rejects.toMatchObject({ step: "disconnect_mark_disconnected" });
  });
  it("Q-1: a clean disconnect deletes the secret and marks the row disconnected", async () => {
    h.script["calendar_connections.select"] = [{ data: { id: "c1" }, error: null }];
    await disconnectConnection("s1", "p1");
    expect(writes().map((w) => `${w.table}.${w.op}`)).toEqual(["calendar_connection_secrets.delete", "calendar_connections.update"]);
  });
});
