import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { E2E_SERVICE_ROLE_KEY, E2E_SUPABASE_URL } from "@/e2e/helpers/local-env";
import { adminQuery, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";

// Removing a member from studio A must clean up ONLY A's membership: this studio's stored credential and connection. The same person's
// Google account may be connected in studio B (calendar_connections.google_account_id is not unique), and a revoke at Google acts on the
// person's grant, so it could end B's sync. Sam's decision (Vercel finding 01M6SPYTZ01MAGB74CGWVV953E): administrative removal never
// calls Google. Real removePractitionerAction against the REAL migrated local DB; Google is a fake that records any revoke call and, like
// the real endpoint, would end the person's grant for every studio that uses it. Synthetic values only.

const KEY = "ab".repeat(32);
const savedEnv = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
  stripe: process.env.STRIPE_SECRET_KEY,
  tokKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY,
  tokVer: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION,
};
const realFetch = globalThis.fetch;
const GOOGLE_CALLS: string[] = [];
let grantRevokedAtGoogle = false;

const SESSION = vi.hoisted(() => ({ current: null as unknown }));
class RedirectSignal extends Error {
  constructor(public url: string) {
    super("NEXT_REDIRECT");
  }
}
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("@/lib/email/client", () => ({ resend: null, FROM_ADDRESS: "Hone <hello@hone.care>" }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({ getCurrentPractitionerWithStudio: vi.fn(async () => SESSION.current) }));

let removePractitionerAction: (fd: FormData) => Promise<void>;
let encrypt: (typeof import("@/lib/google-calendar/token-crypto"))["encryptGoogleSecret"];

beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = E2E_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = E2E_SERVICE_ROLE_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = KEY;
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION = "1";
  ({ encryptGoogleSecret: encrypt } = await import("@/lib/google-calendar/token-crypto"));
  ({ removePractitionerAction } = await import("@/app/(app)/settings/team/actions"));
  // Google is faked: anything addressed to Google is recorded and answered 200; everything else (the local stack) passes through.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/google/i.test(url) && !url.startsWith(E2E_SUPABASE_URL)) {
      GOOGLE_CALLS.push(url);
      if (/revoke/i.test(url)) grantRevokedAtGoogle = true;
      return new Response("{}", { status: 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  process.env.NEXT_PUBLIC_SUPABASE_URL = savedEnv.url;
  process.env.SUPABASE_SERVICE_ROLE_KEY = savedEnv.key;
  process.env.STRIPE_SECRET_KEY = savedEnv.stripe;
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY = savedEnv.tokKey;
  process.env.GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION = savedEnv.tokVer;
  await closePool();
});

beforeEach(() => {
  GOOGLE_CALLS.length = 0;
  grantRevokedAtGoogle = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

type Side = { studio: SeededStudio; member: string; conn: string; cipher: string };

async function connect(studio: SeededStudio, practitionerId: string, account: string, token: string): Promise<Side> {
  const enc = encrypt(token);
  if (!enc.ok) throw new Error("test key not usable");
  const conn = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections (id, studio_id, practitioner_id, connection_status, google_account_id, is_studio_calendar_owner)
     values ($1,$2,$3,'connected',$4,false)`,
    [conn, studio.studioId, practitionerId, account],
  );
  await adminQuery(
    `insert into public.calendar_connection_secrets (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
     values ($1,$2,$3,$4)`,
    [conn, studio.studioId, enc.ciphertext, enc.keyVersion],
  );
  return { studio, member: practitionerId, conn, cipher: enc.ciphertext };
}

// Everything stored for one connection, as one comparable value (the row and its secret row, byte for byte).
async function snapshot(conn: string): Promise<string> {
  const r = await adminQuery(
    `select (select to_jsonb(c) from public.calendar_connections c where c.id = $1) as connection,
            (select to_jsonb(s) from public.calendar_connection_secrets s where s.connection_id = $1) as secret`,
    [conn],
  );
  return JSON.stringify(r.rows[0]);
}

async function removeFromA(a: SeededStudio, memberId: string): Promise<string | undefined> {
  SESSION.current = {
    practitioner: { id: a.practitionerId, role: "owner", display_name: "Owner", email: "owner@harness.local" },
    studio: { id: a.studioId, name: "Studio A" },
  };
  const fd = new FormData();
  fd.set("id", memberId);
  try {
    await removePractitionerAction(fd);
    return undefined;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.url;
    throw e;
  }
}

describe("removal from studio A cleans up A only, even when the same Google account is connected in studio B", () => {
  it("A loses its token and connection; B's connection row and stored token are byte-identical; Google is never called", async () => {
    const account = `acct-${randomUUID()}`;
    const A = await seedStudio("rmA");
    const B = await seedStudio("rmB");
    const aMember = await seedMember(A, "rmAm");
    const sideA = await connect(A, aMember.practitionerId, account, "refresh-token-for-A");
    const sideB = await connect(B, B.practitionerId, account, "refresh-token-for-B");
    expect(sideA.cipher).not.toBe(sideB.cipher); // each connection has its OWN stored token
    const bBefore = await snapshot(sideB.conn);

    const redirected = await removeFromA(A, aMember.practitionerId);

    // A: the member is inactive, the stored token is gone and the connection no longer syncs.
    const active = await adminQuery("select active from public.practitioners where id = $1", [aMember.practitionerId]);
    expect(active.rows[0].active).toBe(false);
    const aSecret = await adminQuery("select 1 from public.calendar_connection_secrets where connection_id = $1", [sideA.conn]);
    expect(aSecret.rowCount).toBe(0);
    const aConn = await adminQuery(
      "select connection_status, is_studio_calendar_owner, disconnected_at from public.calendar_connections where id = $1",
      [sideA.conn],
    );
    expect(aConn.rows[0].connection_status).toBe("disconnected");
    expect(aConn.rows[0].is_studio_calendar_owner).toBe(false);
    expect(aConn.rows[0].disconnected_at).not.toBeNull();

    // B: untouched, byte for byte (row and token), and still 'connected'.
    expect(await snapshot(sideB.conn)).toBe(bBefore);
    const bConn = await adminQuery("select connection_status from public.calendar_connections where id = $1", [sideB.conn]);
    expect(bConn.rows[0].connection_status).toBe("connected");

    // Google: no call at all, so the grant B depends on was not revoked.
    expect(GOOGLE_CALLS).toEqual([]);
    expect(grantRevokedAtGoogle).toBe(false);

    // The owner is told honestly, with a fixed code and no other-studio identifier anywhere in the response or the logs.
    expect(redirected).toBe("/settings/team?removed=partial&left=google_access");
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    for (const leak of [B.studioId, sideB.conn, B.practitionerId, account]) {
      expect(redirected ?? "").not.toContain(leak);
      expect(logged).not.toContain(leak);
    }
  });

  it("the cleanup is scoped by studio AND practitioner: a same-account connection in the SAME studio for a different member is untouched too", async () => {
    const account = `acct-${randomUUID()}`;
    const A = await seedStudio("rmC");
    const removed = await seedMember(A, "rmCm");
    const kept = await seedMember(A, "rmCk");
    const sideRemoved = await connect(A, removed.practitionerId, account, "refresh-token-removed");
    const sideKept = await connect(A, kept.practitionerId, account, "refresh-token-kept");
    const keptBefore = await snapshot(sideKept.conn);
    await removeFromA(A, removed.practitionerId);
    expect(await snapshot(sideKept.conn)).toBe(keptBefore);
    const gone = await adminQuery("select 1 from public.calendar_connection_secrets where connection_id = $1", [sideRemoved.conn]);
    expect(gone.rowCount).toBe(0);
    expect(GOOGLE_CALLS).toEqual([]);
  });

  it("a member with no stored credential is removed without any Google notice and without touching anything else", async () => {
    const A = await seedStudio("rmD");
    const member = await seedMember(A, "rmDm");
    expect(await removeFromA(A, member.practitionerId)).toBeUndefined();
    expect(GOOGLE_CALLS).toEqual([]);
  });
});

describe("the member's own Disconnect is studio-local too (the same two store calls the action makes)", () => {
  it("A's own Disconnect clears A's secret and row only: B's token is byte-identical, another member of A is untouched, Google is never called", async () => {
    const account = `acct-${randomUUID()}`;
    const A = await seedStudio("dcA");
    const B = await seedStudio("dcB");
    const other = await seedMember(A, "dcAo");
    const sideA = await connect(A, A.practitionerId, account, "refresh-token-A-self");
    const sideOther = await connect(A, other.practitionerId, account, "refresh-token-A-other");
    const sideB = await connect(B, B.practitionerId, account, "refresh-token-B");
    const bBefore = await snapshot(sideB.conn);
    const otherBefore = await snapshot(sideOther.conn);

    const { getRefreshTokenCiphertext, disconnectConnection } = await import("@/lib/google-calendar/connection");
    expect(await getRefreshTokenCiphertext(A.studioId, A.practitionerId)).toBe(sideA.cipher);
    await disconnectConnection(A.studioId, A.practitionerId);

    const aSecret = await adminQuery("select 1 from public.calendar_connection_secrets where connection_id = $1", [sideA.conn]);
    expect(aSecret.rowCount).toBe(0);
    const aConn = await adminQuery("select connection_status from public.calendar_connections where id = $1", [sideA.conn]);
    expect(aConn.rows[0].connection_status).toBe("disconnected");
    expect(await getRefreshTokenCiphertext(A.studioId, A.practitionerId)).toBeNull(); // nothing left to sync with
    expect(await snapshot(sideB.conn)).toBe(bBefore);
    expect(await snapshot(sideOther.conn)).toBe(otherBefore);
    expect(await getRefreshTokenCiphertext(B.studioId, B.practitionerId)).toBe(sideB.cipher); // B can still mint tokens
    expect(GOOGLE_CALLS).toEqual([]);
    expect(grantRevokedAtGoogle).toBe(false);
  });

  it("a studio id paired with another studio's practitioner matches nothing (both columns scope the cleanup)", async () => {
    const account = `acct-${randomUUID()}`;
    const A = await seedStudio("dcC");
    const B = await seedStudio("dcD");
    const sideB = await connect(B, B.practitionerId, account, "refresh-token-B2");
    const before = await snapshot(sideB.conn);
    const { disconnectConnection } = await import("@/lib/google-calendar/connection");
    await disconnectConnection(A.studioId, B.practitionerId);
    expect(await snapshot(sideB.conn)).toBe(before);
  });
});
