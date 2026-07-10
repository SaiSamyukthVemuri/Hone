import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #182 + migration 0116 (phase 2). Source-grep tests pin the rotation/clear
// action to writing ONLY the hash column. The raw calendar_feed_token column
// was dropped in 0116 (hash-only at rest); the settings UI now reads feed
// existence from the hash and renders the URL only from the action's one-time
// return value.

const ACTIONS_PATH = path.resolve(
  __dirname,
  "../../../../app/(app)/settings/profile/actions.ts",
);
const ACTIONS = readFileSync(ACTIONS_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ACTIONS_CODE = codeOnly(ACTIONS);

describe("rotateCalendarFeedTokenAction: uses the shared helpers", () => {
  it("imports generateCalendarFeedToken + hashCalendarFeedToken from lib/calendar-feed/token", () => {
    expect(ACTIONS).toMatch(
      /import \{\s*\n?\s*generateCalendarFeedToken,\s*\n?\s*hashCalendarFeedToken,\s*\n?\s*\} from "@\/lib\/calendar-feed\/token"/,
    );
  });

  it("does NOT import randomBytes from node:crypto directly any more", () => {
    expect(ACTIONS).not.toMatch(
      /import \{[^}]*randomBytes[^}]*\} from "crypto"/,
    );
    expect(ACTIONS).not.toMatch(
      /import \{[^}]*randomBytes[^}]*\} from "node:crypto"/,
    );
  });

  it("computes the hash via the shared helper", () => {
    expect(ACTIONS).toMatch(
      /const tokenHash = hashCalendarFeedToken\(token\);/,
    );
  });
});

describe("rotateCalendarFeedTokenAction: writes ONLY the hash (phase 2 / 0116)", () => {
  it("the UPDATE body sets calendar_feed_token_hash and NOT the raw token", () => {
    expect(ACTIONS).toMatch(
      /\.update\(\{\s*\n?\s*calendar_feed_token_hash: tokenHash,\s*\n?\s*\}\)/,
    );
    expect(ACTIONS).not.toMatch(/calendar_feed_token: token,/);
  });

  it("scopes the update to the calling practitioner", () => {
    expect(ACTIONS).toMatch(
      /\.eq\("id", practitioner\.id\)/,
    );
  });

  it("returns the raw token to the caller so the UI can render the URL once", () => {
    expect(ACTIONS).toMatch(
      /return \{ ok: true, token \};/,
    );
  });

  it("does NOT return the hash to the caller", () => {
    // The CalendarFeedResult union is { ok: true; token: string } |
    // { ok: false; error: string }. Pin the type declaration and
    // the single success return shape; neither carries the hash.
    expect(ACTIONS).toMatch(
      /export type CalendarFeedResult\s*=\s*\|\s*\{ ok: true; token: string \}/,
    );
    const successReturns =
      ACTIONS.match(/return \{ ok: true,[^}]+\};/g) ?? [];
    expect(successReturns.length).toBeGreaterThanOrEqual(1);
    for (const r of successReturns) {
      expect(r).not.toMatch(/tokenHash/);
      expect(r).not.toMatch(/calendar_feed_token_hash/);
    }
  });
});

describe("clearCalendarFeedTokenAction: nulls ONLY the hash (phase 2 / 0116)", () => {
  it("nulls calendar_feed_token_hash and NOT the raw column", () => {
    expect(ACTIONS).toMatch(
      /\.update\(\{\s*\n?\s*calendar_feed_token_hash: null,\s*\n?\s*\}\)/,
    );
    expect(ACTIONS).not.toMatch(/calendar_feed_token: null,/);
  });
});

describe("settings actions: PR #182 phase-1 boundaries", () => {
  it("does NOT touch any payment / Stripe code", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /paymentIntents\.create|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE/,
    );
  });

  it("does NOT log raw tokens via console.error or structured logs (code only)", () => {
    expect(ACTIONS_CODE).not.toMatch(
      /console\.error\([\s\S]{0,200}calendar_feed_token/,
    );
  });

  it("does NOT send SMS / email", () => {
    expect(ACTIONS_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });
});

describe("phase 2 (migration 0116): raw-token writes are gone", () => {
  it("the actions no longer write the raw calendar_feed_token column", () => {
    // 0116 dropped the raw column; the UI reads existence from the hash and
    // renders the URL only from the action's one-time return value. A refactor
    // that reintroduced a raw-column write would be caught here.
    expect(ACTIONS).not.toMatch(/calendar_feed_token: token,/);
    expect(ACTIONS).not.toMatch(/calendar_feed_token: null,/);
  });
});
