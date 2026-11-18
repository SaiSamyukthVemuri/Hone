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

describe("rotateCalendarFeedTokenAction: uses the shared hash helper", () => {
  it("computes the hash via the shared helper", () => {
    expect(ACTIONS).toMatch(
      /const tokenHash = hashCalendarFeedToken\(token\);/,
    );
  });
});

describe("rotateCalendarFeedTokenAction: writes ONLY the hash (phase 2 / 0116)", () => {
  it("only the HASH crosses into the database, never the raw token", () => {
    // 0178 moved the write from a direct `.update()` to a governed command, but
    // the 0116 property this test exists for is unchanged and is re-asserted
    // against the shape that now carries it.
    expect(ACTIONS).toMatch(/p_token_hash: tokenHash/);
    expect(ACTIONS).not.toMatch(/calendar_feed_token: token,/);
    expect(ACTIONS).not.toMatch(/p_token_hash: token\b/);
  });

  it("scopes the write to the calling practitioner — now in the DATABASE", () => {
    // STRONGER than the old `.eq("id", practitioner.id)`: no practitioner id is
    // sent at all. The command binds the actor to auth.uid() and the explicit
    // studio, so the caller cannot name a row to write even if it wanted to.
    expect(ACTIONS).toMatch(/set_own_calendar_feed_token_hash/);
    expect(ACTIONS).toMatch(/p_studio_id: studio\.id/);
    expect(ACTIONS).not.toMatch(/\.eq\("id", practitioner\.id\)/);
    expect(ACTIONS).not.toMatch(/p_practitioner_id/);
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
    // 0178: NULL is passed as a VALUE to the governed command — revoking a feed
    // is a real operation, not "leave unchanged".
    expect(ACTIONS).toMatch(/p_token_hash: null/);
    expect(ACTIONS).not.toMatch(/calendar_feed_token: null,/);
  });
});
