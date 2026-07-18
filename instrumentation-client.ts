import posthog from "posthog-js";

// Token-bearing route prefixes that must never have their URLs sent to
// analytics. These are credentials; the same list is enforced structurally in
// the SafeAnalytics component, and sanitized here as a defence-in-depth layer.
const TOKEN_PATH_PREFIXES = [
  "/portal/verify/",
  "/cancel/",
  "/reschedule/",
  "/manage/",
  "/intake/",
  "/calendar-feed/",
];

function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    for (const prefix of TOKEN_PATH_PREFIXES) {
      if (parsed.pathname.startsWith(prefix)) {
        parsed.pathname = prefix + "[token]";
        return parsed.toString();
      }
    }
  } catch {
    // Non-URL string; return as-is
  }
  return url;
}

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://us.posthog.com",
  defaults: "2026-01-30",
  capture_exceptions: true,
  debug: process.env.NODE_ENV === "development",
  sanitize_properties: (properties) => {
    const urlKeys = ["$current_url", "$referrer"];
    for (const key of urlKeys) {
      if (typeof properties[key] === "string") {
        properties[key] = sanitizeUrl(properties[key] as string);
      }
    }
    return properties;
  },
});
