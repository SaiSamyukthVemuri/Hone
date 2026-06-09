import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #182. Source-grep tests pin the calendar feed route's switch
// from raw-token lookup to SHA-256 hash lookup. The route's runtime
// is the credential check for the entire feed; a refactor that
// re-introduces raw matching would silently downgrade security.

const ROUTE_PATH = path.resolve(
  __dirname,
  "../../../app/calendar-feed/[token]/route.ts",
);
const ROUTE = readFileSync(ROUTE_PATH, "utf8");

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const ROUTE_CODE = codeOnly(ROUTE);

describe("calendar feed route: hash lookup wiring", () => {
  it("imports hashCalendarFeedToken from the shared helper", () => {
    expect(ROUTE).toMatch(
      /import \{ hashCalendarFeedToken \} from "@\/lib\/calendar-feed\/token"/,
    );
  });

  it("hashes the URL token before the practitioner SELECT", () => {
    const hashIdx = ROUTE.indexOf("hashCalendarFeedToken(token)");
    const selectIdx = ROUTE.indexOf('.from("practitioners")');
    expect(hashIdx).toBeGreaterThan(-1);
    expect(selectIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeLessThan(selectIdx);
  });

  it("looks up the practitioner via calendar_feed_token_hash", () => {
    expect(ROUTE).toMatch(
      /\.eq\("calendar_feed_token_hash", tokenHash\)/,
    );
  });

  it("does NOT look up by the raw calendar_feed_token column (code only)", () => {
    // Comment text legitimately mentions the column name; the
    // negative grep targets the actual lookup shape.
    expect(ROUTE_CODE).not.toMatch(
      /\.eq\("calendar_feed_token",\s*token\)/,
    );
  });

  it("does NOT include the raw calendar_feed_token column in the SELECT", () => {
    expect(ROUTE_CODE).not.toMatch(
      /\.select\([^)]*calendar_feed_token[^_]/,
    );
  });
});

describe("calendar feed route: privacy + safety contracts", () => {
  it("does NOT log the raw token in the structured error line", () => {
    // The route's existing error log only carries the Postgres error
    // code; pin that the raw token is NOT JSON-stringified anywhere.
    expect(ROUTE_CODE).not.toMatch(/token:\s*token/);
    expect(ROUTE_CODE).not.toMatch(/calendar_feed_token:\s*token/);
  });

  it("does NOT return the hash to the client", () => {
    // The response body is either the ICS feed or a generic 'Not
    // found'. The route must not echo tokenHash into NextResponse.
    expect(ROUTE_CODE).not.toMatch(/tokenHash[\s\S]{0,200}NextResponse/);
  });

  it("still returns a generic 'Not found' on lookup failure", () => {
    const notFoundCount = (ROUTE.match(/"Not found"/g) ?? []).length;
    expect(notFoundCount).toBeGreaterThanOrEqual(2);
  });

  it("still strips the trailing .ics extension from the URL token", () => {
    expect(ROUTE).toMatch(/\.replace\(\/\\\.ics\$\/i, ""\)/);
  });

  it("still refuses tokens shorter than 16 characters", () => {
    expect(ROUTE).toMatch(/token\.length < 16/);
  });
});

describe("calendar feed route: PR #182 phase-1 boundaries", () => {
  it("does NOT touch any payment / Stripe code", () => {
    expect(ROUTE_CODE).not.toMatch(
      /paymentIntents\.create|refunds\.create|charges\.create|checkout\.sessions|setupIntents\.create|STRIPE_ALLOW_LIVE_MODE/,
    );
  });

  it("does NOT send SMS / email / push from the route", () => {
    expect(ROUTE_CODE).not.toMatch(/sendEmailSafely|sendSms|twilio/i);
  });
});
