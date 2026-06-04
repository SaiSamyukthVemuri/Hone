// Email allowlist for the /admin portal. Membership grants read access
// across all studios via the service-role client.
//
// Source of truth is the ADMIN_EMAILS env var (comma-separated). Set
// ADMIN_EMAILS in prod to manage the allowlist without a code change,
// e.g.
//
//   ADMIN_EMAILS=samyukth.ssv@gmail.com,other@example.com
//
// Fail-closed in production
// -------------------------
// When NODE_ENV === "production" and ADMIN_EMAILS is unset or empty,
// `isAdmin` returns false for every caller. There is no hardcoded
// production fallback. The previous DEFAULT_ADMIN_EMAILS list (which
// granted admin to a single known address as a lockout-prevention
// crutch) has been removed because it papered over a missing config
// in any environment that booted without ADMIN_EMAILS set. A missing
// env in prod is now visible (admin actions return their early-exit
// path; admin UI routes redirect) and a one-time error is logged so
// the operator can fix the config.
//
// Local development convenience
// -----------------------------
// In non-production environments the built-in DEFAULT_ADMIN_EMAILS
// list is still honored so local dev does not need an .env entry to
// hit /admin. This is safe because dev never serves real client data
// from a production database (the dev Supabase project is separate)
// and the dev secrets do not unlock prod resources.

const DEFAULT_ADMIN_EMAILS: ReadonlyArray<string> = ["samyukth.ssv@gmail.com"];

let missingEnvWarned = false;

function parseAdminEmails(raw: string | undefined): ReadonlyArray<string> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function getAdminEmails(): ReadonlyArray<string> {
  const fromEnv = parseAdminEmails(process.env.ADMIN_EMAILS);
  if (fromEnv.length > 0) return fromEnv;

  // Production: fail closed. No fallback admin.
  if (process.env.NODE_ENV === "production") {
    if (!missingEnvWarned) {
      missingEnvWarned = true;
      // Sanitized server-side log so the operator notices a missing
      // env without leaking config details to any user-visible
      // response. No emails or secrets included.
      console.error(
        JSON.stringify({
          event: "admin_emails_missing_in_production",
          environment: process.env.NODE_ENV,
          timestamp: new Date().toISOString(),
        }),
      );
    }
    return [];
  }

  // Non-production: dev fallback so local development does not need
  // an .env entry to hit /admin.
  return DEFAULT_ADMIN_EMAILS;
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}
