// Email allowlist for the /admin portal. Adding an email here grants
// read access across all studios via the service-role client.

const ADMIN_EMAILS: ReadonlyArray<string> = ["samyukth.ssv@gmail.com"];

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
