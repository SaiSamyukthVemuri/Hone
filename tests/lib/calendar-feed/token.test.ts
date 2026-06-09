import { describe, expect, it } from "vitest";
import {
  generateCalendarFeedToken,
  hashCalendarFeedToken,
} from "@/lib/calendar-feed/token";
import { createHash } from "node:crypto";

// PR #182. Unit tests for the calendar-feed token helpers. The
// hash function is the load-bearing piece for migration 0079's
// backfill + the runtime feed route's lookup; if either drifts the
// existing in-the-wild feed URLs stop resolving on the deploy
// boundary.

describe("hashCalendarFeedToken: shape", () => {
  it("returns a 64-character string", () => {
    expect(hashCalendarFeedToken("abc")).toHaveLength(64);
  });

  it("returns lowercase hex only", () => {
    expect(hashCalendarFeedToken("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic: same input gives the same hash", () => {
    const input = "a-real-feed-token-might-look-like-this";
    expect(hashCalendarFeedToken(input)).toBe(hashCalendarFeedToken(input));
  });

  it("different inputs give different hashes", () => {
    expect(hashCalendarFeedToken("a")).not.toBe(hashCalendarFeedToken("b"));
  });

  it("matches Node's createHash('sha256') over UTF-8 directly", () => {
    const input = "matches-the-migration-backfill";
    const direct = createHash("sha256").update(input, "utf8").digest("hex");
    expect(hashCalendarFeedToken(input)).toBe(direct);
  });

  it("does not trim or normalise the input", () => {
    // The route's incoming path segment is the canonical token; the
    // helper must reflect bytes-in -> bytes-hashed. A token with
    // leading whitespace would not have matched the raw column
    // either; behavior is preserved.
    const a = hashCalendarFeedToken("token");
    const b = hashCalendarFeedToken(" token");
    expect(a).not.toBe(b);
  });
});

describe("hashCalendarFeedToken: pgcrypto compatibility (load-bearing)", () => {
  // Migration 0079 backfills the hash column via
  //   encode(extensions.digest(calendar_feed_token, 'sha256'), 'hex')
  // which is the same UTF-8 SHA-256 digest in lowercase hex. The
  // route's lookup uses hashCalendarFeedToken(...) over the same
  // bytes. These tests pin specific known-good vectors so a future
  // refactor that accidentally changes the encoding is caught.
  it("hash('') is the empty-string SHA-256", () => {
    expect(hashCalendarFeedToken("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hash('abc') is the standard NIST SHA-256 vector", () => {
    expect(hashCalendarFeedToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("generateCalendarFeedToken: high-entropy random output", () => {
  it("returns a non-empty string", () => {
    expect(generateCalendarFeedToken().length).toBeGreaterThan(0);
  });

  it("returns base64url characters only (no padding, URL-safe)", () => {
    const token = generateCalendarFeedToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("returns 43 characters for 32 input bytes (base64url unpadded)", () => {
    // 32 bytes encoded as base64url with no padding is exactly 43
    // characters. A drift here would weaken the entropy + change the
    // URL shape that Google Calendar polls.
    const token = generateCalendarFeedToken();
    expect(token).toHaveLength(43);
  });

  it("returns a different value on each call (overwhelmingly probable)", () => {
    const set = new Set(
      Array.from({ length: 50 }, () => generateCalendarFeedToken()),
    );
    expect(set.size).toBe(50);
  });

  it("each generated token hashes cleanly to the 64-hex format the DB CHECK enforces", () => {
    for (let i = 0; i < 25; i++) {
      const token = generateCalendarFeedToken();
      expect(hashCalendarFeedToken(token)).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
