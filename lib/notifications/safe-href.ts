/**
 * A notification's `href` is stored data. Render it as a link only when it is
 * a same-site relative path: one leading "/", not "//" (protocol-relative),
 * no backslash (browsers treat "/\host" as "//host"), no control characters
 * or whitespace, and no scheme. Anything else returns null and the row is
 * shown without a link.
 */
export function safeInAppHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000- \u007f]/.test(href)) return null;
  return href;
}
