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
  // WHY THIS CHANGED. The old expectation pinned a DIRECT table write —
  // `.update({ calendar_feed_token_hash: tokenHash }).eq("id", practitioner.id)`
  // on the authenticated client. Migration 0178 (practitioner identity boundary)
  // revoked UPDATE on public.practitioners from `authenticated`, so that write
  // can no longer exist: it would fail at the privilege layer for every
  // practitioner. The rotation now goes through the narrow SECURITY DEFINER
  // command, which re-checks the hex shape AND the active requirement inside the
  // database.
  //
  // The PROPERTY being pinned is unchanged and is what still matters: only the
  // HASH is ever sent, never the raw token.
  it("sends calendar_feed_token_hash and NEVER the raw token", () => {
    expect(ACTIONS).toMatch(
      /rpc\("rotate_own_calendar_feed_token",\s*\{[\s\S]{0,160}?p_token_hash: tokenHash,/,
    );
    expect(ACTIONS).not.toMatch(/calendar_feed_token: token,/);
    expect(ACTIONS, "the raw token must never be a command argument").not.toMatch(
      /p_token: token\b/,
    );
  });

  // WHY THIS CHANGED. Scoping used to be expressed as `.eq("id", practitioner.id)`
  // on a direct UPDATE — i.e. the CLIENT chose the row. Under 0178 the id is a
  // LOCATOR only: the command proves `user_id = auth.uid()` in SQL, so a caller
  // passing someone else's id is refused regardless of studio ownership. This
  // pins the id still being passed, and the DB suite
  // (tests/db/practitioner-identity-boundary.db.test.ts) proves the refusal.
  it("scopes the command to the calling practitioner", () => {
    expect(ACTIONS).toMatch(/p_practitioner_id: practitioner\.id/);
    expect(ACTIONS, "no direct table write may remain").not.toMatch(
      /\.from\(\s*["']practitioners["']\s*\)/,
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
  // WHY THIS CHANGED. Same reason as rotation: the direct
  // `.update({ calendar_feed_token_hash: null })` is impossible under 0178. The
  // clear command takes no value at all — it can ONLY null the hash — which is a
  // stronger guarantee than the old expectation, because there is no argument
  // through which any other value could be supplied.
  it("clears the hash through a command that can set nothing else", () => {
    expect(ACTIONS).toMatch(/rpc\("clear_own_calendar_feed_token",\s*\{/);
    expect(ACTIONS).not.toMatch(/calendar_feed_token: null,/);
    // The clear command's ONLY argument is the locator.
    const call = ACTIONS.slice(ACTIONS.indexOf('rpc("clear_own_calendar_feed_token"'));
    const args = call.slice(0, call.indexOf("})"));
    expect(args).toMatch(/p_practitioner_id: practitioner\.id/);
    expect(args, "no value argument exists on the clear command").not.toMatch(/hash|token:/i);
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
