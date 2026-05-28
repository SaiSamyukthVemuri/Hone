// Email allowlist for the /admin portal. Membership grants read access
// across all studios via the service-role client.
//
// Source of truth is the ADMIN_EMAILS env var (comma-separated). When it
// is unset or empty the built-in default below is used. Set ADMIN_EMAILS
// in prod to manage the allowlist without a code change, e.g.
//   ADMIN_EMAILS=samyukth.ssv@gmail.com,other@example.com
//
// Fallback semantics (intentional):
//   * The default applies ONLY when ADMIN_EMAILS is unset or empty.
//   * This is deliberate lockout prevention for the current single-admin
//     phase: admin access must not break before ADMIN_EMAILS is set in an
//     environment.
//   * Future cleanup: once ADMIN_EMAILS is confirmed present in production
//     env, the default can be dropped and ADMIN_EMAILS made required.
// (DB-backed admin roles are intentionally out of scope here.)

const DEFAULT_ADMIN_EMAILS: ReadonlyArray<string> = ["samyukth.ssv@gmail.com"];

function parseAdminEmails(raw: string | undefined): ReadonlyArray<string> {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

function getAdminEmails(): ReadonlyArray<string> {
  const fromEnv = parseAdminEmails(process.env.ADMIN_EMAILS);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_ADMIN_EMAILS;
}

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return getAdminEmails().includes(email.toLowerCase());
}
