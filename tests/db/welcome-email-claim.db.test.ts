import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { adminQuery, asRole, closePool, seedStudio } from "./helpers/harness";

// Migration 0141 — welcome-email single-attempt claim. Proves the atomic
// idempotency that keeps concurrent resends / rapid double-clicks to one send,
// and that only the trusted service-role adapter can claim.

afterAll(async () => {
  await closePool();
});

async function claim(studioId: string): Promise<boolean> {
  const r = await adminQuery(
    `select public.claim_welcome_email_attempt($1) as c`,
    [studioId],
  );
  return r.rows[0].c === true;
}

describe("claim_welcome_email_attempt — single attempt", () => {
  it("first claim succeeds; an immediate second is refused (debounced)", async () => {
    const s = await seedStudio("claim-1");
    expect(await claim(s.studioId)).toBe(true);
    expect(await claim(s.studioId)).toBe(false);
  });

  it("two concurrent claims -> exactly one succeeds", async () => {
    const s = await seedStudio("claim-2");
    const [a, b] = await Promise.all([claim(s.studioId), claim(s.studioId)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("claiming creates/records the studio_onboarding attempt timestamp", async () => {
    const s = await seedStudio("claim-3");
    await claim(s.studioId);
    const row = await adminQuery(
      `select welcome_email_last_sent_at from public.studio_onboarding where studio_id=$1`,
      [s.studioId],
    );
    expect(row.rows[0].welcome_email_last_sent_at).not.toBeNull();
  });
});

describe("claim_welcome_email_attempt — authorization", () => {
  it("anon cannot execute the claim", async () => {
    await expect(
      asRole("anon", (q) =>
        q(`select public.claim_welcome_email_attempt($1)`, [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });

  it("an authenticated browser role cannot execute the claim", async () => {
    await expect(
      asRole("authenticated", (q) =>
        q(`select public.claim_welcome_email_attempt($1)`, [randomUUID()]),
      ),
    ).rejects.toThrow(/permission denied|not allowed|42501/i);
  });
});
