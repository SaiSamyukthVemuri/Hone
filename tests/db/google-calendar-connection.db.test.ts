import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  adminQuery,
  closePool,
  seedMember,
  seedStudio,
  userQuery,
  type SeededStudio,
} from "./helpers/harness";

// Google Calendar — Phase A. Behavioral proof against the REAL migrated local DB
// (0121/0122): tenant isolation, the browser-inaccessible secret + state tables,
// the one-connection / one-owner constraints, cross-studio-attachment blocks,
// and single-use OAuth state consumption.

afterAll(async () => {
  await closePool();
});

const HEX64 = "a".repeat(64);

async function insertConnection(
  studio: SeededStudio,
  opts: { practitionerId?: string; owner?: boolean; status?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await adminQuery(
    `insert into public.calendar_connections
       (id, studio_id, practitioner_id, connection_status, is_studio_calendar_owner)
     values ($1,$2,$3,$4,$5)`,
    [
      id,
      studio.studioId,
      opts.practitionerId ?? studio.practitionerId,
      opts.status ?? "connected",
      opts.owner ?? false,
    ],
  );
  return id;
}

describe("0121 — tenant isolation on calendar_connections", () => {
  it("a member can read only their OWN studio's connection metadata", async () => {
    const a = await seedStudio("gcalA");
    const b = await seedStudio("gcalB");
    const aConn = await insertConnection(a);
    const bConn = await insertConnection(b);

    const ownVisible = await userQuery(
      a.userId,
      "select id from public.calendar_connections where id = $1",
      [aConn],
    );
    expect(ownVisible.rowCount).toBe(1);

    const foreignVisible = await userQuery(
      a.userId,
      "select id from public.calendar_connections where id = $1",
      [bConn],
    );
    expect(foreignVisible.rowCount).toBe(0);
  });

  it("a member cannot mutate another studio's connection (no write policy)", async () => {
    const a = await seedStudio("gcalC");
    const b = await seedStudio("gcalD");
    const bConn = await insertConnection(b);
    const upd = await userQuery(
      a.userId,
      "update public.calendar_connections set connection_status='revoked' where id = $1",
      [bConn],
    );
    expect(upd.rowCount).toBe(0);
  });
});

describe("0121 — calendar_connection_secrets is browser-inaccessible", () => {
  it("the authenticated role cannot SELECT the secrets table", async () => {
    const a = await seedStudio("gcalE");
    const conn = await insertConnection(a);
    await adminQuery(
      `insert into public.calendar_connection_secrets
         (connection_id, studio_id, encrypted_refresh_token, encryption_key_version)
       values ($1,$2,$3,$4)`,
      [conn, a.studioId, "v1:1:iv:tag:ct", 1],
    );
    await expect(
      userQuery(a.userId, "select encrypted_refresh_token from public.calendar_connection_secrets"),
    ).rejects.toThrow();
  });

  it("the authenticated role cannot INSERT/UPDATE/DELETE the secrets table", async () => {
    const a = await seedStudio("gcalF");
    const conn = await insertConnection(a);
    await expect(
      userQuery(
        a.userId,
        "insert into public.calendar_connection_secrets (connection_id, studio_id, encryption_key_version) values ($1,$2,1)",
        [conn, a.studioId],
      ),
    ).rejects.toThrow();
    await expect(
      userQuery(a.userId, "update public.calendar_connection_secrets set encrypted_refresh_token='x'"),
    ).rejects.toThrow();
    await expect(
      userQuery(a.userId, "delete from public.calendar_connection_secrets"),
    ).rejects.toThrow();
  });
});

describe("0121 — connection + owner constraints", () => {
  it("allows only one connection per practitioner", async () => {
    const a = await seedStudio("gcalG");
    await insertConnection(a);
    await expect(insertConnection(a)).rejects.toThrow();
  });

  it("allows at most one active studio calendar owner per studio", async () => {
    const a = await seedStudio("gcalH");
    const member = await seedMember(a, "gcalH-2");
    await insertConnection(a, { owner: true });
    await expect(
      insertConnection(a, { practitionerId: member.practitionerId, owner: true }),
    ).rejects.toThrow();
    // A non-owner second connection is fine.
    const ok = await insertConnection(a, { practitionerId: member.practitionerId, owner: false });
    expect(ok).toBeTruthy();
  });

  it("blocks cross-studio attachment (composite FK)", async () => {
    const a = await seedStudio("gcalI");
    const b = await seedStudio("gcalJ");
    // studio A row pointing at studio B's practitioner must fail.
    await expect(
      insertConnection(a, { practitionerId: b.practitionerId }),
    ).rejects.toThrow();
  });

  it("blocks a secret row attached to the wrong studio (composite FK)", async () => {
    const a = await seedStudio("gcalK");
    const b = await seedStudio("gcalL");
    const conn = await insertConnection(a);
    await expect(
      adminQuery(
        `insert into public.calendar_connection_secrets (connection_id, studio_id, encryption_key_version) values ($1,$2,1)`,
        [conn, b.studioId],
      ),
    ).rejects.toThrow();
  });
});

describe("0122 — google_oauth_states", () => {
  async function insertState(studio: SeededStudio, expiresInMinutes = 10): Promise<string> {
    const id = randomUUID();
    await adminQuery(
      `insert into public.google_oauth_states
         (id, state_hash, session_nonce_hash, studio_id, practitioner_id, user_id,
          encrypted_pkce_verifier, encryption_key_version, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' minutes')::interval)`,
      [id, HEX64, HEX64, studio.studioId, studio.practitionerId, studio.userId, "v1:1:iv:tag:ct", 1, String(expiresInMinutes)],
    );
    return id;
  }

  it("consumes a state exactly once (replay rejected)", async () => {
    const a = await seedStudio("gcalM");
    const id = await insertState(a);
    const first = await adminQuery(
      "update public.google_oauth_states set consumed_at = now() where id = $1 and consumed_at is null returning id",
      [id],
    );
    expect(first.rowCount).toBe(1);
    const replay = await adminQuery(
      "update public.google_oauth_states set consumed_at = now() where id = $1 and consumed_at is null returning id",
      [id],
    );
    expect(replay.rowCount).toBe(0);
  });

  it("is unreadable by the authenticated role", async () => {
    const a = await seedStudio("gcalN");
    await insertState(a);
    await expect(
      userQuery(a.userId, "select encrypted_pkce_verifier from public.google_oauth_states"),
    ).rejects.toThrow();
  });

  it("enforces the sha256-hex CHECK on state_hash", async () => {
    const a = await seedStudio("gcalO");
    await expect(
      adminQuery(
        `insert into public.google_oauth_states
           (state_hash, session_nonce_hash, studio_id, practitioner_id, user_id, encrypted_pkce_verifier, encryption_key_version)
         values ($1,$2,$3,$4,$5,$6,1)`,
        ["not-a-hash", HEX64, a.studioId, a.practitionerId, a.userId, "v1:1:iv:tag:ct"],
      ),
    ).rejects.toThrow();
  });
});
