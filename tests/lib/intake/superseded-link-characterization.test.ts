import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// HON-75 (CHARACTERIZATION, not a requirement): what a REISSUED intake link does to the EARLIER link, today. These tests pin current behaviour so that the product
// ruling (Sam's 5h: should a reissue invalidate earlier links?) flips them deliberately. If the answer is yes, replace the "still verifies" cases with
// "is refused as replaced" and add the replaced-link screen; do not delete them silently.
const INTAKE = "11111111-1111-4111-8111-111111111111";
let prevSecret: string | undefined;
beforeEach(() => {
  prevSecret = process.env.INTAKE_SIGNING_SECRET;
  process.env.INTAKE_SIGNING_SECRET = "synthetic-secret-for-tests-0123456789abcdef";
});
afterEach(() => {
  if (prevSecret === undefined) delete process.env.INTAKE_SIGNING_SECRET;
  else process.env.INTAKE_SIGNING_SECRET = prevSecret;
  vi.useRealTimers();
});

describe("a superseded intake link still verifies (current behaviour)", () => {
  it("two tokens minted for the same intake both verify, so the earlier one survives a reissue", async () => {
    const { generateIntakeToken, verifyIntakeToken } = await import("@/lib/intake/tokens");
    const day = 86_400_000;
    const first = generateIntakeToken(INTAKE, new Date(Date.now() + 14 * day));
    const reissued = generateIntakeToken(INTAKE, new Date(Date.now() + 14 * day + 1000));
    expect(first).not.toBe(reissued);
    for (const t of [first, reissued]) {
      const v = verifyIntakeToken(t);
      expect(v.ok && v.intake_id).toBe(INTAKE);
    }
  });

  it("only the token's OWN signed expiry ends it: an expired token is refused, a later-expiring earlier one is not", async () => {
    const { generateIntakeToken, verifyIntakeToken } = await import("@/lib/intake/tokens");
    expect(verifyIntakeToken(generateIntakeToken(INTAKE, new Date(Date.now() - 1000)))).toEqual({ ok: false, error: "expired" });
    expect(verifyIntakeToken(generateIntakeToken(INTAKE, new Date(Date.now() + 60_000))).ok).toBe(true);
  });

  it("the reissue stamp refreshes the stored expiry and counters only; it writes no revocation, version or token field", async () => {
    const { stampIntakeLinkIssued } = await import("@/lib/intake/queries");
    const patches: Record<string, unknown>[] = [];
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { intake_link_send_count: 1 } }) }) }),
        update: (p: Record<string, unknown>) => {
          patches.push(p);
          return { eq: async () => ({ error: null }) };
        },
      }),
    };
    await stampIntakeLinkIssued(admin as never, INTAKE, { emailed: true });
    expect(patches.length).toBe(1);
    expect(Object.keys(patches[0]).sort()).toEqual(["intake_link_expires_at", "intake_link_last_sent_at", "intake_link_send_count"]);
    expect(patches[0].intake_link_send_count).toBe(2);
  });

  it("the public page and actions decide by the signed token, never by the stored expiry or a 'latest link' check", () => {
    for (const f of ["app/intake/[token]/page.tsx", "app/intake/[token]/actions.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("verifyIntakeToken");
      expect(src, f).not.toContain("intake_link_expires_at");
      expect(src, f).not.toMatch(/supersed|revok|link_replaced|replaced_at/i);
    }
  });
});
