import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// #1373 F-1: the account-switch gate must not be skipped by a failed store read. Runs the REAL callback route and the REAL connection.ts
// against a fake admin client that returns the real Supabase { data, error } shapes. Only the network (Google), the session and the
// single-use state are stubbed. Synthetic values.

type Reply = { data: unknown; error: { code: string; message: string } | null };
// A key may hold ONE reply (every call) or a LIST (consumed in call order, the last repeats).
const STORE = vi.hoisted(() => ({ replies: {} as Record<string, Reply | Reply[]>, writes: [] as string[], used: {} as Record<string, number> }));
const next = (k: string, d: Reply): Reply => {
  const r = STORE.replies[k];
  if (!r) return d;
  if (!Array.isArray(r)) return r;
  const i = STORE.used[k] ?? 0;
  STORE.used[k] = i + 1;
  return r[Math.min(i, r.length - 1)];
};
const LOG = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/lib/app-origin", () => ({ getRequiredAppOrigin: () => "https://app.example.test" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: "nonce" }) }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } }),
}));
vi.mock("@/lib/google-calendar/state", () => ({
  consumeOAuthState: async () => ({
    ok: true,
    studioId: "studio-1",
    practitionerId: "prac-1",
    codeVerifier: "v",
    redirectPath: "/settings/profile",
    destinationMode: null,
    requiredEventScope: null,
  }),
}));
vi.mock("@/lib/google-calendar/oauth", () => ({
  exchangeAuthorizationCode: async () => ({
    ok: true,
    accessToken: "at",
    refreshToken: "rt",
    expiresInSeconds: 3600,
    grantedScopes: [(await import("@/lib/google-calendar/config")).CALENDAR_DISCOVERY_SCOPE],
  }),
  fetchTokenInfoScopes: async () => ({ ok: false }),
  fetchUserInfo: async () => ({ ok: true, sub: "google-sub-NEW", email: "new@example.test" }),
  fetchCalendarList: async () => ({ ok: true, calendars: [] }),
}));
vi.mock("@/lib/google-calendar/token-crypto", () => ({
  encryptGoogleSecret: () => ({ ok: true, ciphertext: "ct", last4: "1234", keyVersion: 1 }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      let op = "select";
      const key = () => `${table}:${op}`;
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "limit", "order"]) chain[m] = () => chain;
      for (const m of ["insert", "update", "upsert", "delete"]) {
        chain[m] = () => {
          op = m;
          STORE.writes.push(key());
          return chain;
        };
      }
      chain.maybeSingle = async () => next(key(), { data: null, error: null });
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve(next(key(), { data: null, error: null }));
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { GET } from "@/app/api/google-calendar/oauth/callback/route";

const ERR = { code: "57014", message: "statement timeout (row text must not travel)" };
const req = () => new NextRequest("https://app.example.test/api/google-calendar/oauth/callback?state=s&code=c");

beforeEach(() => {
  STORE.replies = { "practitioners:select": { data: { id: "prac-1", active: true }, error: null } };
  STORE.writes = [];
  STORE.used = {};
  LOG.calls = [];
  vi.spyOn(console, "error").mockImplementation((m: unknown) => {
    LOG.calls.push(String(m));
  });
});

describe("oauth callback: a store error is not 'no existing connection' (F-1)", () => {
  const HEALTHY_ROW = { data: { id: "c1", google_account_id: "google-sub-OLD", connection_status: "connected" }, error: null };

  it("a failed ACCOUNT-ID read (the metadata read before it succeeded) stops the callback: no write, redirect gcal=error, exact log string", async () => {
    // First select = getOwnConnectionMetadata (ok), second = getConnectionAccountId (store error).
    STORE.replies["calendar_connections:select"] = [HEALTHY_ROW, { data: null, error: ERR }];
    const res = await GET(req());
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).searchParams.get("gcal")).toBe("error");
    expect(STORE.writes).toEqual([]);
    expect(LOG.calls).toContain("google_calendar_error:oauth_callback:read_account_id");
    expect(LOG.calls.join("|")).not.toMatch(/row text|57014/);
  });

  it("a failed METADATA read stops the callback the same way (read_metadata)", async () => {
    STORE.replies["calendar_connections:select"] = { data: null, error: ERR };
    const res = await GET(req());
    expect(new URL(res.headers.get("location")!).searchParams.get("gcal")).toBe("error");
    expect(STORE.writes).toEqual([]);
    expect(LOG.calls).toContain("google_calendar_error:oauth_callback:read_metadata");
  });

  it("control: with a healthy read and a DIFFERENT stored account the gate fires (account_mismatch) and nothing is written", async () => {
    STORE.replies["calendar_connections:select"] = HEALTHY_ROW;
    const res = await GET(req());
    expect(new URL(res.headers.get("location")!).searchParams.get("gcal")).toBe("account_mismatch");
    expect(STORE.writes).toEqual([]);
  });
});
