// ===========================================================================
// Where sign-in may send a user afterwards (LEAD-ALERT-01, Codex P2 4248920454)
// ===========================================================================
//
// A return path is ATTACKER-INFLUENCED: it arrives in a query string or a
// cookie. Only a same-origin, relative path may ever become a redirect, and
// the admin return target is narrower still: a path under /admin. Anything
// else -- an absolute URL, a scheme, a protocol-relative `//host`, a
// backslash (which browsers treat as `/`), a userinfo `@`, a control
// character, or an over-long value -- is refused, and the caller falls back
// to its own default.
//
// Pure: no I/O, no env.
// ===========================================================================

/** The cookie the middleware sets when it sends an unauthenticated /admin request to /login. */
export const ADMIN_RETURN_COOKIE = "hone_admin_return";
/** Long enough to request and open a sign-in link; short enough not to linger. */
export const ADMIN_RETURN_MAX_AGE_SECONDS = 15 * 60;

const MAX_LENGTH = 512;
const PROBE_ORIGIN = "https://return-path.invalid";

/**
 * A same-origin relative path (with its query, never a fragment), or null.
 * The result is re-serialised from a parsed URL, so what is returned is what
 * a browser would navigate to.
 */
export function safeInternalPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LENGTH) return null;
  // Exactly one leading slash: `//host` and `/\host` are other origins.
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || raw.includes("@")) return null;
  // Control and whitespace characters (tab and newline are stripped by URL
  // parsers, which would turn `/\t/evil` into `//evil`).
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  return `${url.pathname}${url.search}`;
}

/** A safe internal path under /admin, or null. */
export function safeAdminReturnPath(raw: unknown): string | null {
  const path = safeInternalPath(raw);
  if (!path) return null;
  const pathname = path.split("?")[0];
  return pathname === "/admin" || pathname.startsWith("/admin/") ? path : null;
}
