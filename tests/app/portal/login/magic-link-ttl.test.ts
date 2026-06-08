import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #166. Secure-link expiry audit. Chloe reported the portal
// magic link "stopped working under 30 mins." Root cause: the
// MAGIC_LINK_TTL_MS constant was 30 minutes, which is shorter
// than the real-world delivery + read window for some clients.
// The fix raises it to 60 minutes and keeps the email body copy
// in sync via lib/email/templates/portal-magic-link.ts. This
// file pins the new constant + the comment-block reference so a
// future refactor cannot silently lower the TTL again. The
// source-grep approach mirrors tests/app/portal/layout-cleanup
// .test.ts so the regression surface is identical.

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../../app/portal/login/actions.ts",
);
const SOURCE = readFileSync(ACTIONS_PATH, "utf8");

describe("portal magic-link TTL", () => {
  it("MAGIC_LINK_TTL_MS is exactly 60 * 60 * 1000 (1 hour)", () => {
    // The constant declaration must read "60 * 60 * 1000" so the
    // numeric value is greppable. We do NOT allow "3_600_000" or
    // "60 * 60_000" or any other equivalent; the chosen form keeps
    // the minute count visible to a reviewer.
    expect(SOURCE).toMatch(
      /const MAGIC_LINK_TTL_MS = 60 \* 60 \* 1000;/,
    );
  });

  it("the prior 30-minute literal is gone from the constant line", () => {
    // The comment block above the constant DOES mention "30
    // minutes" (it documents the prior value and the rationale
    // for the change), so we cannot grep for the bare string.
    // Instead we pin the absence of the prior expression on the
    // const line specifically.
    expect(SOURCE).not.toMatch(
      /const MAGIC_LINK_TTL_MS = 30 \* 60 \* 1000;/,
    );
  });

  it("the rationale comment names PR #166 and the delivery-latency reason", () => {
    // A future engineer who lowers the TTL again should see the
    // history. The comment block specifically calls out PR #166
    // and the email-delivery + click-time gap so the rationale
    // is searchable.
    expect(SOURCE).toMatch(/PR #166/);
    expect(SOURCE).toMatch(/delivery/i);
  });

  it("the TTL is still bounded (not, e.g., infinite or > 24h)", () => {
    // Defense against a wild future refactor: a one-hour value
    // is fine; a 24-hour or longer value crosses into "this is a
    // long-lived credential" territory and would need a separate
    // security review.
    const match = SOURCE.match(
      /const MAGIC_LINK_TTL_MS = (\d+) \* (\d+) \* (\d+);/,
    );
    expect(match).not.toBeNull();
    if (match) {
      const ms =
        Number(match[1]) * Number(match[2]) * Number(match[3]);
      expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
      expect(ms).toBeGreaterThanOrEqual(30 * 60 * 1000);
    }
  });
});

describe("portal magic-link insert uses the TTL constant", () => {
  it("expiresAt is computed from MAGIC_LINK_TTL_MS, not a literal", () => {
    // The insert site must read the TTL from the constant so a
    // future change is single-source. A literal minute count
    // wired directly into the insert would defeat the TTL test
    // above.
    expect(SOURCE).toMatch(
      /const expiresAt = new Date\(Date\.now\(\) \+ MAGIC_LINK_TTL_MS\)/,
    );
  });

  it("the magic link still inserts into client_portal_magic_links", () => {
    // Sanity check on the table name; if the table moves, this
    // test will fail and the next reviewer will know to update
    // the audit doc.
    expect(SOURCE).toMatch(/from\("client_portal_magic_links"\)/);
  });
});
