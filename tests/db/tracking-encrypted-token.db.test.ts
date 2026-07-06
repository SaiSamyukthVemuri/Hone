import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  adminQuery,
  asUser,
  closePool,
  seedMember,
  seedStudio,
  type SeededStudio,
} from "./helpers/harness";
import { encryptTrackingProviderToken } from "@/lib/conversion/token-crypto";

// Migration 0107: self-serve encrypted tokens. Proves raw tokens are never
// stored, and that only OWNERS may manage provider config (RLS via
// is_studio_owner).

const RAW_TOKEN = "EAAG_test_capi_token_9876";
let a: SeededStudio;
let b: SeededStudio;
let memberOfA: { userId: string };

beforeAll(async () => {
  process.env.TRACKING_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
  a = await seedStudio("trk-a"); // a.userId is the OWNER
  b = await seedStudio("trk-b");
  memberOfA = await seedMember(a, "trk-a-member"); // non-owner practitioner

  const enc = encryptTrackingProviderToken(RAW_TOKEN);
  if (!enc.ok) throw new Error("encrypt failed in test setup");
  await adminQuery(
    `insert into public.studio_tracking_providers
       (studio_id, provider, enabled, browser_tag_id, encrypted_server_token, server_token_last4, token_status, server_token_added_at)
     values ($1, 'meta', false, 'PX', $2, $3, 'active', now())`,
    [a.studioId, enc.encrypted, enc.last4],
  );
});

afterAll(async () => {
  await closePool();
});

describe("0107 — raw token never stored", () => {
  it("stores ciphertext + last4, never the raw token", async () => {
    const { rows } = await adminQuery(
      `select encrypted_server_token, server_token_last4, token_status
       from public.studio_tracking_providers where studio_id = $1 and provider = 'meta'`,
      [a.studioId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].encrypted_server_token).not.toContain(RAW_TOKEN);
    expect(rows[0].encrypted_server_token).toContain(":"); // iv:tag:ct blob
    expect(rows[0].server_token_last4).toBe("9876");
    expect(rows[0].token_status).toBe("active");
  });
});

describe("0107 — only OWNERS manage provider config (RLS)", () => {
  it("the studio owner can update their own config", async () => {
    const res = await asUser(a.userId, (q) =>
      q(
        `update public.studio_tracking_providers set enabled = true
         where studio_id = $1 and provider = 'meta'`,
        [a.studioId],
      ),
    );
    expect(res.rowCount).toBe(1);
  });

  it("a non-owner member CANNOT update the config (0 rows, RLS)", async () => {
    const res = await asUser(memberOfA.userId, (q) =>
      q(
        `update public.studio_tracking_providers set enabled = false
         where studio_id = $1 and provider = 'meta'`,
        [a.studioId],
      ),
    );
    expect(res.rowCount).toBe(0);
    // still enabled from the owner's update above
    const { rows } = await adminQuery(
      `select enabled from public.studio_tracking_providers where studio_id = $1 and provider = 'meta'`,
      [a.studioId],
    );
    expect(rows[0].enabled).toBe(true);
  });

  it("another studio's owner CANNOT update studio A's config (cross-studio)", async () => {
    const res = await asUser(b.userId, (q) =>
      q(
        `update public.studio_tracking_providers set enabled = false
         where studio_id = $1 and provider = 'meta'`,
        [a.studioId],
      ),
    );
    expect(res.rowCount).toBe(0);
  });

  it("a non-owner member cannot INSERT a provider config for their studio", async () => {
    await expect(
      asUser(memberOfA.userId, (q) =>
        q(
          `insert into public.studio_tracking_providers (studio_id, provider) values ($1, 'ga4')`,
          [a.studioId],
        ),
      ),
    ).rejects.toThrow();
  });
});
