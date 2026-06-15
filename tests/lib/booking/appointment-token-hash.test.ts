import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  generateAppointmentToken,
  hashAppointmentToken,
} from "@/lib/booking/appointment-token";

// PR #260: the at-rest hashing helper for appointment cancel/reschedule
// tokens. This is the security-critical pure logic; the DB-integration
// lane (tests/db/appointment-token-hash.db.test.ts) proves the SQL side
// agrees with this.

describe("hashAppointmentToken", () => {
  it("is SHA-256 hex (64 lowercase hex chars), matching the migration CHECK", () => {
    const h = hashAppointmentToken("any-raw-token");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  it("equals node crypto SHA-256 hex of the same input", () => {
    const raw = "abc123-_token";
    expect(hashAppointmentToken(raw)).toBe(
      createHash("sha256").update(raw, "utf8").digest("hex"),
    );
  });

  it("is deterministic and one-way (same input → same hash)", () => {
    const raw = generateAppointmentToken();
    expect(hashAppointmentToken(raw)).toBe(hashAppointmentToken(raw));
  });

  it("maps distinct tokens to distinct hashes", () => {
    const a = hashAppointmentToken(generateAppointmentToken());
    const b = hashAppointmentToken(generateAppointmentToken());
    expect(a).not.toBe(b);
  });

  it("does NOT trim — whitespace changes the hash (URL path is canonical)", () => {
    expect(hashAppointmentToken("tok")).not.toBe(hashAppointmentToken(" tok "));
  });
});

describe("generateAppointmentToken", () => {
  it("produces a high-entropy url-safe token that hashes to a valid at-rest value", () => {
    const raw = generateAppointmentToken();
    // url-safe base64 of 24 bytes, no padding (~32 chars), no +/=/ characters.
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(raw.length).toBeGreaterThanOrEqual(32);
    expect(hashAppointmentToken(raw)).toMatch(/^[a-f0-9]{64}$/);
    // A raw token is never itself a valid stored hash (no cross-matching
    // between the raw column and the hash column).
    expect(raw).not.toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns a fresh token each call", () => {
    expect(generateAppointmentToken()).not.toBe(generateAppointmentToken());
  });
});
