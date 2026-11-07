import { beforeEach, describe, expect, it, vi } from "vitest";

// A failed Supabase call returns { data: null, error } and does not throw. Before this, getRefreshTokenCiphertext answered null (read as
// "no connection") and disconnectConnection returned normally even when the secret delete failed, so a caller reported a disconnect that
// never happened. Synthetic values; real Supabase return shapes.

type Reply = { data: unknown; error: { code: string; message: string } | null };
const STORE = vi.hoisted(() => ({
  replies: {} as Record<string, Reply>,
  calls: [] as string[],
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let op = "select";
      const chain: Record<string, unknown> = {};
      const key = () => `${table}:${op}`;
      chain.select = () => chain;
      chain.delete = () => {
        op = "delete";
        return chain;
      };
      chain.update = () => {
        op = "update";
        return chain;
      };
      chain.upsert = () => {
        op = "upsert";
        return chain;
      };
      chain.eq = () => chain;
      chain.maybeSingle = async () => {
        STORE.calls.push(key());
        return STORE.replies[key()] ?? { data: null, error: null };
      };
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => {
        STORE.calls.push(key());
        resolve(STORE.replies[key()] ?? { data: null, error: null });
      };
      return chain;
    },
  }),
}));

import {
  ConnectionStoreError,
  disconnectConnection,
  getConnectionAccountId,
  getOwnConnectionMetadata,
  getRefreshTokenCiphertext,
  persistConnectedFromCallback,
  setDestinationMode,
} from "@/lib/google-calendar/connection";

const ERR = { code: "57014", message: "canceling statement due to statement timeout (row text must not travel)" };

beforeEach(() => {
  STORE.replies = {};
  STORE.calls = [];
});

describe("getRefreshTokenCiphertext", () => {
  it("returns the ciphertext on a healthy read", async () => {
    STORE.replies["calendar_connections:select"] = { data: { id: "c1" }, error: null };
    STORE.replies["calendar_connection_secrets:select"] = { data: { encrypted_refresh_token: "ct" }, error: null };
    await expect(getRefreshTokenCiphertext("s1", "p1")).resolves.toBe("ct");
  });

  it("returns null only when there really is no connection or no secret", async () => {
    await expect(getRefreshTokenCiphertext("s1", "p1")).resolves.toBeNull();
    STORE.replies["calendar_connections:select"] = { data: { id: "c1" }, error: null };
    await expect(getRefreshTokenCiphertext("s1", "p1")).resolves.toBeNull();
  });

  it("THROWS when the connection read fails (it used to answer null)", async () => {
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    const e = await getRefreshTokenCiphertext("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("read_connection");
    expect(e.code).toBe("57014");
    expect(e.message).not.toMatch(/row text/);
  });

  it("THROWS when the secret read fails", async () => {
    STORE.replies["calendar_connections:select"] = { data: { id: "c1" }, error: null };
    STORE.replies["calendar_connection_secrets:select"] = { data: null, error: ERR };
    const e = await getRefreshTokenCiphertext("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("read_secret");
  });
});

describe("disconnectConnection", () => {
  const found = { data: { id: "c1" }, error: null };

  it("does nothing, and does not throw, when there is no connection", async () => {
    await expect(disconnectConnection("s1", "p1")).resolves.toBeUndefined();
    expect(STORE.calls).toEqual(["calendar_connections:select"]);
  });

  it("deletes the secret then marks the connection disconnected", async () => {
    STORE.replies["calendar_connections:select"] = found;
    await expect(disconnectConnection("s1", "p1")).resolves.toBeUndefined();
    expect(STORE.calls).toEqual(["calendar_connections:select", "calendar_connection_secrets:delete", "calendar_connections:update"]);
  });

  it("THROWS when the connection lookup fails", async () => {
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    const e = await disconnectConnection("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("disconnect_read_connection");
  });

  it("THROWS when the secret delete fails, and does not mark the connection disconnected over a stored ciphertext", async () => {
    STORE.replies["calendar_connections:select"] = found;
    STORE.replies["calendar_connection_secrets:delete"] = { data: null, error: ERR };
    const e = await disconnectConnection("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("disconnect_delete_secret");
    expect(STORE.calls).not.toContain("calendar_connections:update");
  });

  it("THROWS when marking the connection disconnected fails", async () => {
    STORE.replies["calendar_connections:select"] = found;
    STORE.replies["calendar_connections:update"] = { data: null, error: ERR };
    const e = await disconnectConnection("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("disconnect_mark_disconnected");
  });
});

describe("the other connection reads (sweep): an error is never 'absent'", () => {
  it("getConnectionAccountId: null only when there is no connection; THROWS on a store error (it used to answer null and skip the account gate)", async () => {
    await expect(getConnectionAccountId("s1", "p1")).resolves.toBeNull();
    STORE.replies["calendar_connections:select"] = { data: { google_account_id: "sub-1" }, error: null };
    await expect(getConnectionAccountId("s1", "p1")).resolves.toBe("sub-1");
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    const e = await getConnectionAccountId("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("read_account_id");
  });

  it("getOwnConnectionMetadata: null when absent, THROWS on a store error", async () => {
    await expect(getOwnConnectionMetadata("s1", "p1")).resolves.toBeNull();
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    const e = await getOwnConnectionMetadata("s1", "p1").catch((x) => x);
    expect(e).toBeInstanceOf(ConnectionStoreError);
    expect(e.step).toBe("read_metadata");
  });

  it("setDestinationMode: a store error is store_read_failed, not connection_not_found", async () => {
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    await expect(setDestinationMode("s1", "p1", "dedicated_app_created")).resolves.toEqual({ ok: false, reason: "store_read_failed" });
    STORE.replies["calendar_connections:select"] = { data: null, error: null };
    await expect(setDestinationMode("s1", "p1", "dedicated_app_created")).resolves.toEqual({ ok: false, reason: "connection_not_found" });
  });

  it("persistConnectedFromCallback with no new refresh token: a failed secret read is secret_read_failed and does NOT mark the connection reconnect_required", async () => {
    STORE.replies["calendar_connections:upsert"] = { data: { id: "c1" }, error: null };
    STORE.replies["calendar_connections:select"] = { data: { id: "c1" }, error: null };
    STORE.replies["calendar_connection_secrets:select"] = { data: null, error: ERR };
    const r = await persistConnectedFromCallback({
      studioId: "s1",
      practitionerId: "p1",
      googleAccountId: "sub-1",
      googleAccountEmail: "a@example.test",
      grantedScopes: ["x"],
      tokenExpiresAt: new Date().toISOString(),
      writeCalendarId: null,
      encryptedRefreshToken: null,
      refreshTokenLast4: null,
      encryptionKeyVersion: 1,
    });
    expect(r).toEqual({ ok: false, reason: "secret_read_failed" });
    expect(STORE.calls).not.toContain("calendar_connections:update");
  });
});
