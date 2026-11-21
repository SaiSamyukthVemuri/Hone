// The booking request key: the opaque, single-purpose token that makes a booking attempt safe to retry (a retry after a lost answer replays the original
// confirmation instead of booking twice). THIS MODULE IS THE RULE ONLY. No command, route or form uses it yet: the table, the commands that take the key
// and the form that carries it ship as their own reviewed changes.
//
// The canonical shape (one rule, spelled once, compared as the SAME string in the database):
//   - exactly 32 characters, each one of 0-9 or a-f (lower case): 128 random bits, hex-encoded;
//   - an anchored match over the WHOLE string. A key is REJECTED, never repaired: no trimming, no case folding, no Unicode normalisation, and a trailing
//     newline is not allowed, because a lenient reader on one side and a strict one on the other is how two spellings of one key reach a unique index;
//   - the database applies the same pattern text (`REQUEST_KEY_SQL_PATTERN`) to the same string with no normalisation on either side.
// A key is minted on the SERVER when the form is rendered (never from client data) and is stored only as a hash; this module never hashes or stores it.
//
// TEMPORARY: the project's other canonical retry-key rule lives in a change that has not landed. Until it does this module carries its own copy, pinned
// by the shared vectors in tests/fixtures/request-key-vectors.ts; when it lands the two collapse into ONE module and these vectors become the single test.

/** The number of random bytes in a key: 16 bytes, 128 bits. */
export const REQUEST_KEY_BYTES = 16;

/** The canonical pattern. Anchored at both ends; JavaScript's `$` (without the `m` flag) matches only at the very end, not before a final newline. */
export const REQUEST_KEY_PATTERN = /^[0-9a-f]{32}$/;

/** The SAME pattern as text, for the database's `~` operator. Pinned equal to the pattern's source by a test. */
export const REQUEST_KEY_SQL_PATTERN = "^[0-9a-f]{32}$";

/**
 * How long a committed booking keeps replaying under its key, in hours. ONE named number so the decision is a one-line change. PROPOSED: 24; the final
 * value is a product decision that is not made yet.
 */
export const REQUEST_KEY_REPLAY_WINDOW_HOURS = 24;

/** True when `value` is a string in the canonical shape. Never trims or folds. */
export function isRequestKey(value: unknown): value is string {
  return typeof value === "string" && REQUEST_KEY_PATTERN.test(value);
}

/** The key if it is canonical, otherwise null. The value is returned unchanged: there is no repair path. */
export function parseRequestKey(value: unknown): string | null {
  return isRequestKey(value) ? value : null;
}

/** A fresh key from the platform's cryptographic random source. Server-side only: a client must never choose its own. */
export function mintRequestKey(): string {
  const bytes = new Uint8Array(REQUEST_KEY_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}
