import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { hashFingerprint } from "@/lib/portal/tokens";

// PR #261. Public booking PII log minimization.
//
// app/book/[slug]/actions.ts is the UNAUTHENTICATED public booking
// server-action surface, and its only log sink is
// logInternalBookingError -> console.error(JSON.stringify(detail)) with
// no redaction layer. Two error paths used to write raw client PII into
// those logs:
//   * public_booking_archived_client_collision -> normalizedEmail + the
//     internal archived client UUID.
//   * public_booking_unique_race_unresolved   -> normalizedEmail + the
//     raw Postgres error.message.
//
// These source-grep pins lock the minimized payloads in place: no raw
// email, no client UUID, no raw DB message ever reaches a public
// booking log again, and a salted, deterministic emailFingerprint is
// used instead so an operator can still correlate repeated failures.
// A regression that re-adds any raw identifier is caught here.

const REPO_ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const ACTIONS = read("app/book/[slug]/actions.ts");

// Pull out every logInternalBookingError("event", { ... }); call body so
// each can be asserted independently. Non-greedy up to the first `});`.
function logCall(event: string): string {
  const re = new RegExp(
    `logInternalBookingError\\("${event}",\\s*\\{[\\s\\S]*?\\}\\);`,
  );
  return ACTIONS.match(re)?.[0] ?? "";
}

// Anchor on `("` so this matches literal-event call sites
// (logInternalBookingError("ev", {...})) and NOT the function definition
// (logInternalBookingError(event: unknown...)).
//
// BOOK-01 P2-A WIDENED THIS. The post-commit fail-soft helper logs through
// `logInternalBookingError(event, {...})` with the event as a VARIABLE, so the
// `("`-only anchor skipped it entirely and a whole new logging path, one that
// runs on every unexpected post-commit exception, was invisible to every
// invariant below. The second pattern closes that hole. The function DEFINITION
// is still excluded because it is `logInternalBookingError(event: string`, with
// a type annotation rather than a comma.
const ALL_LOG_CALLS = [
  ...ACTIONS.matchAll(/logInternalBookingError\("[\s\S]*?\}\);/g),
  ...ACTIONS.matchAll(/logInternalBookingError\(event,[\s\S]*?\}\);/g),
].map((m) => m[0]);

// ---------------------------------------------------------------------------
// Helper wiring: the public booking action reuses the portal fingerprint
// helper rather than introducing a new one.
// ---------------------------------------------------------------------------

describe("public booking action imports the reused fingerprint helper", () => {
  it("imports hashFingerprint from the portal tokens module", () => {
    expect(ACTIONS).toMatch(
      /import \{ hashFingerprint \} from "@\/lib\/portal\/tokens"/,
    );
  });
});

// ---------------------------------------------------------------------------
// The two named PII leak paths are minimized.
// ---------------------------------------------------------------------------

describe("public_booking_archived_client_collision logs no raw PII", () => {
  const block = logCall("public_booking_archived_client_collision");

  it("call site still exists", () => {
    expect(block).not.toBe("");
  });

  it("does NOT log the raw normalized email as a payload field", () => {
    // Allowed only as the hashFingerprint(normalizedEmail) argument
    // (followed by `)`), never as a bare `normalizedEmail,` property.
    expect(block).not.toMatch(/\bnormalizedEmail\s*[,}]/);
  });

  it("does NOT log the archived client UUID", () => {
    expect(block).not.toContain("archivedClientId");
    expect(block).not.toContain("winner.id");
  });

  it("logs a salted emailFingerprint instead", () => {
    expect(block).toContain(
      "emailFingerprint: hashFingerprint(normalizedEmail)",
    );
  });

  it("flags the collision with a non-identifying boolean + studioId", () => {
    expect(block).toContain("archivedClientCollision: true");
    expect(block).toContain("studioId: studio.id");
  });
});

describe("public_booking_unique_race_unresolved logs no raw PII", () => {
  const block = logCall("public_booking_unique_race_unresolved");

  it("call site still exists", () => {
    expect(block).not.toBe("");
  });

  it("does NOT log the raw normalized email as a payload field", () => {
    expect(block).not.toMatch(/\bnormalizedEmail\s*[,}]/);
  });

  it("does NOT log the raw Postgres error message", () => {
    expect(block).not.toMatch(/\bmessage\s*:/);
  });

  it("keeps the sqlstate code, studioId, and a salted emailFingerprint", () => {
    expect(block).toContain("code: clientErr.code");
    expect(block).toContain("studioId: studio.id");
    expect(block).toContain(
      "emailFingerprint: hashFingerprint(normalizedEmail)",
    );
  });
});

// ---------------------------------------------------------------------------
// Whole-surface invariant: NO public booking log payload may carry a raw
// email, a raw client UUID, or a raw DB message, now or in future edits.
// ---------------------------------------------------------------------------

describe("every public booking log payload is PII-minimized", () => {
  // Authoritative guard. A denylist of known-bad field names is leaky
  // (a regression could log `email: x` or shorthand `clientPhone,`
  // under a name we forgot to ban). Instead we ALLOWLIST the only safe
  // payload keys and fail on anything else, forcing a reviewer to
  // consciously approve any new field a public booking log emits.
  const ALLOWED_PAYLOAD_KEYS = new Set([
    "code", // Postgres sqlstate, low-cardinality, non-PII
    "studioId", // tenant id (already logged historically)
    "emailFingerprint", // salted SHA-256 of the normalized email
    "archivedClientCollision", // non-identifying boolean discriminator
    // BOOK-01 P2-A, consciously approved:
    "appointmentId", // opaque UUID the studio already owns; no PII
    "errorClass", // the error's CLASS only ("TypeError"), never its message
  ]);

  // Top-level keys of the `{ ... }` object literal in a captured call.
  // The payloads are flat (no nested objects/ternaries), so every
  // `identifier:` in the object body is a payload key.
  function payloadKeys(block: string): string[] {
    const body = block.slice(block.indexOf("{") + 1, block.lastIndexOf("}"));
    return [...body.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
  }

  it("finds the known booking log call sites", () => {
    // 8 logInternalBookingError calls exist today; a new one must also
    // obey the invariants below, so we assert presence, not an exact
    // count, and then sweep them all.
    expect(ALL_LOG_CALLS.length).toBeGreaterThanOrEqual(8);
  });

  it("only ever logs allowlisted payload keys (catches any new field)", () => {
    for (const block of ALL_LOG_CALLS) {
      for (const key of payloadKeys(block)) {
        expect(
          ALLOWED_PAYLOAD_KEYS.has(key),
          `Unexpected key "${key}" in a public booking log payload, if it is safe, add it to ALLOWED_PAYLOAD_KEYS; if it is PII, remove it:\n${block}`,
        ).toBe(true);
      }
    }
  });

  // Explicit denylist pins below document the SPECIFIC historical leaks
  // this PR removed. They are redundant with the allowlist but make a
  // regression's failure message self-explanatory. Each guard covers
  // both `key: value`, shorthand `key,`, and the raw value token.

  it("never logs a raw email (raw, normalized, or any email-ish key)", () => {
    for (const block of ALL_LOG_CALLS) {
      // raw value tokens passed as a property value/shorthand...
      expect(block, block).not.toMatch(/\bnormalizedEmail\s*[,}]/);
      expect(block, block).not.toMatch(/:\s*normalizedEmail\b/);
      expect(block, block).not.toMatch(/:\s*email\b/);
      // ...and any email-ish KEY other than the allowed emailFingerprint.
      const emailish = [...block.matchAll(/\b(\w*[eE]mail\w*)\s*[:,}]/g)]
        .map((m) => m[1])
        .filter((k) => k !== "emailFingerprint" && k !== "normalizedEmail");
      expect(emailish, block).toEqual([]);
    }
  });

  it("never logs a client UUID identifier", () => {
    for (const block of ALL_LOG_CALLS) {
      expect(block, block).not.toContain("archivedClientId");
      expect(block, block).not.toMatch(/\bclient[A-Z_]?\w*[iI]d\b/);
      expect(block, block).not.toContain("winner.id");
    }
  });

  it("never logs a raw DB error message/details/hint", () => {
    for (const block of ALL_LOG_CALLS) {
      expect(block, block).not.toMatch(/\b(message|details|hint)\s*[:,}]/);
      expect(block, block).not.toMatch(/\.\s*(message|details|hint)\b/);
    }
  });

  it("never logs raw phone, name, notes, or tokens (key OR shorthand)", () => {
    for (const block of ALL_LOG_CALLS) {
      // key:, shorthand, and compound forms (clientPhone, clientName...)
      expect(block, block).not.toMatch(/\b\w*[pP]hone\w*\s*[:,}]/);
      expect(block, block).not.toMatch(/\b\w*[nN]ame\w*\s*[:,}]/);
      expect(block, block).not.toMatch(/\bnotes\s*[:,}]/);
      expect(block, block).not.toMatch(
        /\b(cancellation_token|appointmentToken|token_hash|cancellation_token_hash)\b/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The emailFingerprint contract the minimized logs rely on.
// ---------------------------------------------------------------------------

describe("emailFingerprint contract (hashFingerprint)", () => {
  const SAMPLE = "client@example.com";

  it("is deterministic for the same normalized email", () => {
    expect(hashFingerprint(SAMPLE)).toBe(hashFingerprint(SAMPLE));
  });

  it("never equals the raw email and is 64-char lowercase hex", () => {
    const fp = hashFingerprint(SAMPLE);
    expect(fp).not.toBeNull();
    expect(fp).not.toContain(SAMPLE);
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("distinguishes different emails", () => {
    expect(hashFingerprint("a@example.com")).not.toBe(
      hashFingerprint("b@example.com"),
    );
  });

  it("returns null for empty/missing input (so an absent email logs null)", () => {
    expect(hashFingerprint("")).toBeNull();
    expect(hashFingerprint(null)).toBeNull();
    expect(hashFingerprint(undefined)).toBeNull();
  });
});
