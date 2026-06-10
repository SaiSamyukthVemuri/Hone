import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #183. lib/portal/session.ts previously "fired" the
// last_seen_at touch as a bare `void admin.from(...).update(...)`
// builder. Supabase/PostgREST builders are lazy thenables: without
// await or .then(...) no request is ever sent, so last_seen_at was
// never written. These source-grep tests pin the fixed shape: the
// builder chain ends in .then(...) (executed, still fire-and-forget),
// the failure path logs a sanitized structured event, and none of
// the surrounding session security behavior changed.

const SESSION_PATH = path.resolve(
  __dirname,
  "../../../lib/portal/session.ts",
);
const SESSION = readFileSync(SESSION_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const SESSION_CODE = codeOnly(SESSION);

describe("last_seen_at touch: builder actually executes", () => {
  it("no bare lazy `void admin...update(...).eq(...);` builder remains (code only)", () => {
    // The buggy form ended the statement right after .eq(...). The
    // fixed form continues the chain with .then(. Match any void
    // builder statement whose chain terminates without .then/await.
    expect(SESSION_CODE).not.toMatch(
      /void admin\s*\.from\("client_portal_sessions"\)\s*\.update\([\s\S]{0,200}?\)\s*\.eq\([^)]*\);/,
    );
  });

  it("the last_seen_at update chain is executed via .then(...)", () => {
    expect(SESSION_CODE).toMatch(
      /\.update\(\{ last_seen_at: nowIso \}\)\s*\.eq\("id", data\.id\)\s*\.then\(/,
    );
  });

  it("the touch still targets client_portal_sessions and only sets last_seen_at", () => {
    expect(SESSION_CODE).toMatch(
      /\.from\("client_portal_sessions"\)\s*\.update\(\{ last_seen_at: nowIso \}\)/,
    );
  });

  it("the touch remains fire-and-forget (void, not awaited)", () => {
    expect(SESSION_CODE).toMatch(
      /void admin\s*\.from\("client_portal_sessions"\)\s*\.update\(\{ last_seen_at: nowIso \}\)/,
    );
    expect(SESSION_CODE).not.toMatch(
      /await admin\s*\.from\("client_portal_sessions"\)\s*\.update\(\{ last_seen_at: nowIso \}\)/,
    );
  });
});

describe("last_seen_at touch: failure visibility", () => {
  it("failure path logs the portal_session_last_seen_update_failed event", () => {
    const hits =
      SESSION_CODE.match(/portal_session_last_seen_update_failed/g) ?? [];
    // Two arms: PostgREST { error } result and transport rejection.
    expect(hits.length).toBe(2);
  });

  it("the failure log carries the session id (safe identifier)", () => {
    expect(SESSION_CODE).toMatch(
      /portal_session_last_seen_update_failed",\s*\n?\s*sessionId: data\.id/,
    );
  });

  it("the failure log does NOT include the raw token, its hash, or email", () => {
    const blocks =
      SESSION_CODE.match(
        /portal_session_last_seen_update_failed[\s\S]{0,400}?\}\),?\s*\n\s*\);/g,
      ) ?? [];
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block).not.toMatch(/\braw\b/);
      expect(block).not.toMatch(/tokenHash/);
      expect(block).not.toMatch(/session_token_hash/);
      expect(block).not.toMatch(/email/i);
      expect(block).not.toMatch(/client_id|clientId/);
    }
  });

  it("a failed touch cannot change the returned session (handlers return nothing)", () => {
    // The .then arms only log; the function's success return is the
    // plain object literal after the chain, untouched by the touch.
    expect(SESSION_CODE).toMatch(
      /return \{\s*\n?\s*id: data\.id as string,\s*\n?\s*studioId: data\.studio_id as string,\s*\n?\s*clientId: data\.client_id as string,\s*\n?\s*expiresAt: data\.expires_at as string,\s*\n?\s*\};/,
    );
  });
});

describe("session lookup / validity behavior: unchanged", () => {
  it("lookup still filters by session_token_hash via maybeSingle", () => {
    expect(SESSION_CODE).toMatch(
      /\.select\("id, studio_id, client_id, expires_at, revoked_at"\)\s*\.eq\("session_token_hash", tokenHash\)\s*\.maybeSingle\(\)/,
    );
  });

  it("revoked and expired rows still resolve to null", () => {
    expect(SESSION_CODE).toMatch(/if \(data\.revoked_at\) return null;/);
    expect(SESSION_CODE).toMatch(
      /if \(data\.expires_at <= nowIso\) return null;/,
    );
  });

  it("lookup errors still log sanitized and resolve to null", () => {
    expect(SESSION_CODE).toMatch(/portal_session_lookup_failed/);
  });

  it("token hashing still goes through the shared hashToken helper", () => {
    expect(SESSION).toMatch(
      /import \{ generateRawToken, hashToken \} from "\.\/tokens";/,
    );
    expect(SESSION_CODE).toMatch(/const tokenHash = hashToken\(raw\);/);
  });

  it("the module is still server-only", () => {
    expect(SESSION).toMatch(/^import "server-only";/);
  });
});

describe("PR #183 boundaries", () => {
  it("no payment / Stripe code in the portal session module", () => {
    expect(SESSION_CODE).not.toMatch(
      /paymentIntents|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE|stripe/i,
    );
  });

  it("no calendar feed phase 2 surface touched", () => {
    expect(SESSION_CODE).not.toMatch(/calendar_feed_token/);
  });

  it("no SMS / email sending", () => {
    expect(SESSION_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });

  it("portal login timing padding is not imported or altered here", () => {
    expect(SESSION_CODE).not.toMatch(/sleep\(|setTimeout/);
  });
});
