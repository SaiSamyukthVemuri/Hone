import "server-only";
import { createHash, randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// PR #182. Calendar feed token helpers.
// ---------------------------------------------------------------------------
//
// These helpers replace the inline `randomBytes(32).toString("base64url")`
// the rotation action carried before PR #182 + introduce the SHA-256
// hash function the feed route now uses for lookup. The contract:
//
//   * generateCalendarFeedToken returns a base64url-encoded string
//     from 32 bytes of CSPRNG output (256 bits of entropy). This is
//   the same shape PR #46 produced; PR #182 keeps it so any URLs
//   that are still in the wild via the legacy rotation path match
//   the same hash format.
//   * hashCalendarFeedToken returns the SHA-256 hex digest (64
//     lowercase hex chars). The migration 0079 CHECK constraint
//   enforces the same regex.
//
// Security rules:
//   * Raw tokens are NEVER logged.
//   * Hashes are NEVER returned to the browser. The feed route reads
//   them; the settings UI reads/writes only the raw token (phase 1
//   transitional behavior); the rotation action writes the hash as
//   a server-only operation.
//   * trim() is intentionally NOT applied because the URL path
//   segment in the route is the canonical source. A token with
//   leading/trailing whitespace would not have matched the raw
//   lookup either, so behavior is preserved.

const RAW_TOKEN_BYTES = 32; // 256 bits of entropy.

export function generateCalendarFeedToken(): string {
  return randomBytes(RAW_TOKEN_BYTES).toString("base64url");
}

export function hashCalendarFeedToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
