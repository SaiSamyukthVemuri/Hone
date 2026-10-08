// Narrow public-site content negotiation and true 404 handling.
// No auth decision or customer data is made available by this module.

type Representation = "html" | "markdown" | "not-acceptable";
type AcceptEntry = { type: string; q: number; specificity: number; index: number };

function parseAccept(value: string): AcceptEntry[] {
  return value.split(",").map((part, index) => {
    const [rawType, ...parameters] = part.trim().split(";");
    const type = (rawType ?? "").trim().toLowerCase();
    let q = 1;
    for (const parameter of parameters) {
      const [rawName, rawValue] = parameter.trim().split("=");
      if (rawName?.trim().toLowerCase() !== "q") continue;
      const value = (rawValue ?? "").trim();
      // Invalid quality values cannot become permission to serve a type.
      q = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(value)
        ? Number(value)
        : 0;
      break;
    }
    const specificity = type === "*/*" ? 0 : type.endsWith("/*") ? 1 : 2;
    return { type, q, specificity, index };
  });
}

function matches(entry: AcceptEntry, candidate: string): boolean {
  if (entry.type === "*/*") return true;
  if (entry.type.endsWith("/*")) return candidate.startsWith(entry.type.slice(0, -1));
  return entry.type === candidate;
}

// RFC 9110: for each representation, the most specific matching media range
// determines its q-value. Then compare q-values, with request order on ties.
// HTML is the default for absent headers and broad */* requests.
export function preferredPublicRepresentation(accept: string | null): Representation {
  if (!accept || !accept.trim()) return "html";
  const entries = parseAccept(accept);
  let chosen: "html" | "markdown" | null = null;
  let chosenQ = 0;
  let chosenPosition = Number.POSITIVE_INFINITY;
  for (const candidate of ["text/html", "text/markdown"] as const) {
    let best: AcceptEntry | null = null;
    for (const entry of entries) {
      if (!matches(entry, candidate)) continue;
      if (
        !best ||
        entry.specificity > best.specificity ||
        (entry.specificity === best.specificity && entry.index < best.index)
      ) best = entry;
    }
    if (!best || best.q <= 0) continue;
    if (best.q > chosenQ || (best.q === chosenQ && best.index < chosenPosition)) {
      chosen = candidate === "text/markdown" ? "markdown" : "html";
      chosenQ = best.q;
      chosenPosition = best.index;
    }
  }
  return chosen ?? "not-acceptable";
}

export function appendVaryAccept(headers: Headers): void {
  const oldValue = headers.get("Vary");
  if (!oldValue) { headers.set("Vary", "Accept"); return; }
  if (!oldValue.split(",").some((entry) => entry.trim().toLowerCase() === "accept")) {
    headers.set("Vary", oldValue + ", Accept");
  }
}

// A top-level route not in the actual application is otherwise redirected
// by the auth middleware to /login (final 200). These are the known roots in
// app/, app/(app), app/(auth), the documented marketing routes and infrastructure.
// Newly introduced roots fail closed as 404 until intentionally registered.
// Existing known/private/token roots continue through their existing guards.
const ROUTE_ROOTS = new Set([
  "about", "contact", "llms.txt",
  "dashboard", "calendar", "clients", "financials", "getting-started",
  "notifications", "records", "settings", "e2e-fault",
  "accept-invitation", "auth", "login", "no-access", "admin", "api",
  "apple-icon", "book", "calendar-feed", "cancel", "demo", "electrolysis-software",
  "features", "icon", "ingest", "intake", "invitation", "manage", "monitoring",
  "opengraph-image", "portal", "pricing", "privacy", "reschedule", "resources",
  "robots.txt", "sitemap.xml", "terms", "film", "fonts",
  "_next", "_vercel", ".well-known", "__nextjs_original-stack-frame",
]);

const SINGLE_PAGE_ROOTS = new Set([
  "about", "contact", "llms.txt", "demo", "electrolysis-software",
  "pricing", "privacy", "terms", "robots.txt", "sitemap.xml",
  "icon", "apple-icon", "opengraph-image",
]);

export function isUnknownPublicPath(pathname: string): boolean {
  if (!pathname.startsWith("/") || pathname === "/") return false;
  const first = pathname.split("/")[1] ?? "";
  if (!ROUTE_ROOTS.has(first)) return true;
  // A static page cannot have a child route; don't redirect its typo to login.
  return SINGLE_PAGE_ROOTS.has(first) && pathname !== "/" + first;
}

export const NOT_FOUND_HTML = [
  '<!doctype html><html lang="en"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="robots" content="noindex, nofollow">',
  '<title>Page not found · Hone</title></head>',
  '<body style="margin:0;background:#FAFAF7;color:#0A0A0A;font-family:system-ui,-apple-system,sans-serif">',
  '<main style="max-width:720px;margin:0 auto;padding:15vh 24px 64px">',
  '<p style="letter-spacing:.14em;font-size:13px;text-transform:uppercase">Hone · 404</p>',
  '<h1 style="font-size:clamp(36px,6vw,60px);line-height:1.1">Page not found.</h1>',
  '<p>The page or resource you requested does not exist at this address.</p>',
  '<p><a href="/" style="color:#28456B">Home</a> · ',
  '<a href="/sitemap.xml" style="color:#28456B">Sitemap</a> · ',
  '<a href="/llms.txt" style="color:#28456B">Agent guidance</a></p>',
  '</main></body></html>',
].join("");
