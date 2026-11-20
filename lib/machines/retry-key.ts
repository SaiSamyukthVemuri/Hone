/**
 * THE RETRY KEY, ONE SHAPE. A retry key identifies a save whose answer may have been lost. The app mints it with `crypto.randomUUID()`, and
 * three places must agree on what "the same key" means: the application's receipt lookup, the command it calls, and the database's own compare.
 * Normalising it anywhere (JavaScript `trim()` removes tabs, newlines and Unicode spaces; SQL `btrim()` removes spaces only) makes those three
 * disagree: a key with a tab on the front found no receipt in the lookup, skipped the rollout gate, and then reached the command as a DIFFERENT key.
 *
 * So a key is accepted only if it is ALREADY canonical, and the very same string is then used for the lookup and the write. Nothing is trimmed or
 * rewritten. Canonical is: ASCII letters, digits, `_` and `-`, starting with a letter or digit, 8 to 128 characters. That admits every UUID the app
 * mints and refuses whitespace of any kind (space, tab, newline, U+00A0, U+2003, U+3000, ...) and every non-ASCII character, leading, trailing or inside.
 */
const CANONICAL_RETRY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function isCanonicalRetryKey(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_RETRY_KEY.test(value);
}

/** Shown when a key is not canonical. Nothing was sent, so it says nothing was saved. */
export const NON_CANONICAL_KEY_MESSAGE = "This save could not be sent safely. Reload the chart and try again. Nothing was saved.";
