// Proof of MAILBOX CONTROL for the signed-in session.
//
// WHY THIS EXISTS (security, 2 Nov). Supabase AUTO-CONFIRMS an account created while "Confirm email" is OFF, so a non-null
// `email_confirmed_at` does not prove the person controls the mailbox: anyone could have registered someone else's address
// with a password. Two decisions in Hone trust the account's email and therefore need PROOF IN THIS SESSION:
//   * accepting a studio invitation (the invited address is the authority), and
//   * the platform-admin allowlist (lib/admin.ts matches an address).
//
// PROOF is a property of the SESSION, read from the verified access-token claims' `amr` (authentication methods
// references), never from the account row:
//   * `otp` / `magiclink` / `email/signup` / `invite` / `recovery`: a one-time credential that was DELIVERED TO THE
//     ACCOUNT'S EMAIL was redeemed to create this session (GoTrue records the method that created the session).
//   * `oauth` with provider google: the provider asserted email_verified for THE SAME ADDRESS as the account (checked on the
//     Google identity, so a differently-addressed linked identity proves nothing about the account email).
// A `password` session proves nothing about the mailbox, auto-confirmed account or not.
// This module is pure (no I/O) so every rule is table-testable.

export type AmrEntry = { method?: unknown; provider?: unknown; timestamp?: unknown };
export type ProofClaims = { amr?: unknown } | null | undefined;
export type ProofIdentity = { provider?: unknown; identity_data?: Record<string, unknown> | null };
export type ProofUser = { email?: string | null; identities?: ProofIdentity[] | null } | null | undefined;

/** Methods whose credential is delivered to the account's own email address. */
const MAILBOX_METHODS: ReadonlySet<string> = new Set(["otp", "magiclink", "email/signup", "invite", "recovery"]);
/** OAuth providers whose `email_verified` assertion Hone accepts as mailbox proof. */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["google"]);

export type ProofMethod = "email_link_or_otp" | "oauth_verified" | null;

function entries(claims: ProofClaims): AmrEntry[] {
  const amr = claims && typeof claims === "object" ? (claims as { amr?: unknown }).amr : undefined;
  return Array.isArray(amr) ? (amr.filter((e) => e && typeof e === "object") as AmrEntry[]) : [];
}

const norm = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** The method that proves mailbox control in this session, or null. */
export function mailboxProofMethod(claims: ProofClaims, user: ProofUser): ProofMethod {
  const email = norm(user?.email);
  if (!email) return null;
  const amr = entries(claims);

  if (amr.some((e) => typeof e.method === "string" && MAILBOX_METHODS.has(e.method))) return "email_link_or_otp";

  const oauth = amr.filter((e) => e.method === "oauth" && OAUTH_PROVIDERS.has(norm(e.provider)));
  for (const entry of oauth) {
    const identity = (user?.identities ?? []).find((i) => norm(i.provider) === norm(entry.provider));
    const data = identity?.identity_data ?? null;
    if (data && data.email_verified === true && norm(data.email) === email) return "oauth_verified";
  }
  return null;
}

export function sessionProvesMailbox(claims: ProofClaims, user: ProofUser): boolean {
  return mailboxProofMethod(claims, user) !== null;
}

/**
 * Claims of an access token the auth server JUST issued to this server (the `exchangeCodeForSession` result). It is decoded,
 * not verified, so use it ONLY for a token received directly from the auth server in this request, never for a cookie.
 */
export function claimsFromAccessToken(token: string | null | undefined): ProofClaims {
  if (!token) return null;
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as ProofClaims;
  } catch {
    return null;
  }
}
