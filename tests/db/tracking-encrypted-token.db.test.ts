import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";

// Migration 0107 (schema only): encrypted-token columns + OWNER-only management.
// This PR (350A) does not include the crypto helper or the sender; it inserts an
// opaque ciphertext-shaped value to prove: the schema stores an opaque token
// blob (no raw-token column), and only OWNERS can manage provider config (RLS
// via is_studio_owner). No raw token is ever placed in a row.

const OPAQUE = "iv64==:tag64==:ciphertext64=="; // stand-in for AES-GCM ciphertext
let a: SeededStudio;
let b: SeededStudio;
let memberOfA: { userId: string };

beforeAll(async () => {
  a = await seedStudio("trk107-a"); // a.userId is the OWNER
  b = await seedStudio("trk107-b");
  memberOfA = await seedMember(a, "trk107-a-member"); // non-owner practitioner
  await adminQuery(
    `insert into public.studio_tracking_providers
       (studio_id, provider, enabled, browser_tag_id, encrypted_server_token, server_token_last4, token_status, server_token_added_at)
     values ($1, 'meta', false, 'PX', $2, '9876', 'active', now())`,
    [a.studioId, OPAQUE],
  );
});

afterAll(async () => {
  await closePool();
});

describe("0107 — schema stores an opaque token (no raw-token column)", () => {
  it("persists the ciphertext blob + last4 + status", async () => {
    const { rows } = await adminQuery(
      `select encrypted_server_token, server_token_last4, token_status
       from public.studio_tracking_providers where studio_id = $1 and provider = 'meta'`,
      [a.studioId],
    );
    expect(rows[0].encrypted_server_token).toBe(OPAQUE);
    expect(rows[0].server_token_last4).toBe("9876");
    expect(rows[0].token_status).toBe("active");
  });

  it("has no raw-token value column", async () => {
    const { rows } = await adminQuery(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='studio_tracking_providers'`,
    );
    const cols = rows.map((r) => r.column_name);
    for (const raw of ["access_token", "api_token", "token_value", "auth_token", "raw_token"]) {
      expect(cols).not.toContain(raw);
    }
  });
});

describe("0107 — only OWNERS manage provider config (RLS)", () => {
  it("the studio owner can update their own config", async () => {
    const res = await asUser(a.userId, (q) =>
      q(`update public.studio_tracking_providers set enabled = true where studio_id = $1 and provider = 'meta'`, [a.studioId]),
    );
    expect(res.rowCount).toBe(1);
  });

  it("a non-owner member CANNOT update the config (0 rows, RLS)", async () => {
    const res = await asUser(memberOfA.userId, (q) =>
      q(`update public.studio_tracking_providers set enabled = false where studio_id = $1 and provider = 'meta'`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("another studio's owner CANNOT update studio A's config (cross-studio)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(`update public.studio_tracking_providers set enabled = false where studio_id = $1 and provider = 'meta'`, [a.studioId]),
    );
    expect(res.rowCount).toBe(0);
  });

  it("a non-owner member cannot INSERT a provider config", async () => {
    await expect(
      asUser(memberOfA.userId, (q) =>
        q(`insert into public.studio_tracking_providers (studio_id, provider) values ($1, 'ga4')`, [a.studioId]),
      ),
    ).rejects.toThrow();
  });
});
