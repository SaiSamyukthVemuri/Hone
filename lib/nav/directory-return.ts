// Safe "back to the client directory" return-target validation. Same posture as
// appointment-return.ts: NEVER echo an untrusted URL. The only accepted value is
// the internal directory route "/clients", optionally with a query string of
// URL-safe characters (the directory's own filter/sort/page state). Anything
// external, protocol-relative, cross-route, fragment-bearing or oversized is
// rejected and returns null, so the caller falls back to plain "/clients".
const DIRECTORY_RETURN_RE = /^\/clients(\?[A-Za-z0-9_=&%.,+-]*)?$/;
const MAX_LENGTH = 512;

export function sanitizeDirectoryReturnTo(
  value: string | string[] | null | undefined,
): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || v.length > MAX_LENGTH) return null;
  return DIRECTORY_RETURN_RE.test(v) ? v : null;
}
