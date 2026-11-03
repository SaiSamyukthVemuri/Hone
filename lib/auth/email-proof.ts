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
//   * `otp` / `magiclink` / `recovery`: a one-time credential that was DELIVERED TO THE
//     ACCOUNT'S EMAIL was redeemed to create this session (GoTrue records the method that created the session).
//   * `oauth` with provider google: the provider asserted email_verified for THE SAME ADDRESS as the account (checked on the
//     Google identity, so a differently-addressed linked identity proves nothing about the account email).
// A `password` session proves nothing about the mailbox, auto-confirmed account or not.
// This module is pure (no I/O) so every rule is table-testable.

export type AmrEntry = { method?: unknown; provider?: unknown; timestamp?: unknown };
export type ProofClaims = { amr?: unknown } | null | undefined;
export type ProofIdentity = { provider?: unknown; identity_data?: Record<string, unknown> | null; updated_at?: unknown };
export type ProofUser =
  | { email?: string | null; email_change_sent_at?: unknown; identities?: ProofIdentity[] | null }
  | null
  | undefined;

/** Methods whose credential is delivered to the account's own email address. */
// MEASURED on real GoTrue (isolated stack, 3 Nov, Confirm email ON and OFF), per FLOW, because the amr depends on the flow:
//   * implicit /verify (link redeemed by token_hash: invite, magic link, signup-confirmation, recovery, email code): `otp`;
//   * PKCE (what the browser sign-in and /auth/callback actually use): a magic link, new or existing address, is `magiclink`
//     and a recovery link is `recovery`; a PKCE session keeps its amr across refresh (machines/AUTH-PKCE-amr-evidence.json);
//   * a password sign-in AND a password sign-up (Confirm OFF) are `password`.
// So exactly `otp`, `magiclink` and `recovery` count. `email/signup` and `invite` were never observed as an amr method (the
// first cut to `otp` alone refused every browser magic-link sign-in: CI run 41553749973), so they stay unproven until measured.
const MAILBOX_METHODS: ReadonlySet<string> = new Set(["otp", "magiclink", "recovery"]);
/**
 * OAuth providers whose `email_verified` assertion Hone accepts as mailbox proof. THE SET IS CLOSED ON PURPOSE (Insurance G-1):
 * the hosted provider list is email + Google only, and a provider Hone does not list here proves nothing even if it is enabled
 * later. Enabling a new provider (including phone/SMS, which produces no mailbox amr at all) does NOT make it proof; add it HERE,
 * with a unit-test row proving its verified-email semantics, and add it to public.session_proves_mailbox() (held 0291) in the same
 * change. tests/lib/auth/email-proof.test.ts pins this set so an edit cannot go unnoticed.
 */
const OAUTH_PROVIDERS: ReadonlySet<string> = new Set(["google"]);

export type ProofMethod = "email_link_or_otp" | "oauth_verified" | null;

/**
 * S-2b (Insurance Z-1/G-3): mailbox proof must be about the account's CURRENT address. An attacker with a real mailbox can sign in
 * by link, ask to change the account email to a victim's address, and keep the proven session once the victim confirms. So a
 * link-type amr entry counts only if it was made at or after the account's last email-change activity:
 *   lastChange = max(auth.users.email_change_sent_at, updated_at of the account's `email` identity), whole epoch seconds.
 * Measured on real GoTrue (machines/AUTH-S2B-columns-evidence.json): email_change_sent_at moves on an email-change request and on
 * each confirm half; the email identity's updated_at moves only when the change is applied; neither moves on an OTP request, a
 * sign-in or a refresh (users.updated_at moves on all of those, so it is NOT used). Both null = the address never changed = no
 * constraint. A non-null value that cannot be read is treated as "changed just now" (fail closed). Cost: only an account with
 * email-change activity after the session began is asked to confirm again (a fresh link, no lockout).
 */
function lastEmailChangeSeconds(user: ProofUser): number | null | "unreadable" {
  const stamps: unknown[] = [user?.email_change_sent_at];
  for (const identity of user?.identities ?? []) if (norm(identity.provider) === "email") stamps.push(identity.updated_at);
  let latest: number | null = null;
  for (const raw of stamps) {
    if (raw === undefined || raw === null || raw === "") continue;
    const ms = typeof raw === "string" || typeof raw === "number" ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(ms)) return "unreadable";
    const sec = Math.floor(ms / 1000);
    if (latest === null || sec > latest) latest = sec;
  }
  return latest;
}

function madeAfterChange(entry: AmrEntry, lastChange: number | null | "unreadable"): boolean {
  if (lastChange === null) return true;
  if (lastChange === "unreadable") return false;
  return typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp) && Math.floor(entry.timestamp) >= lastChange;
}

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

  const lastChange = lastEmailChangeSeconds(user);
  if (amr.some((e) => typeof e.method === "string" && MAILBOX_METHODS.has(e.method) && madeAfterChange(e, lastChange))) {
    return "email_link_or_otp";
  }

  // GoTrue's amr entry for OAuth is `{method:"oauth", timestamp}`: it does NOT carry the provider (only SAML does; Codex P1,
  // GoTrue v2.189.0 CalculateAALAndAMR). So the provider is read from the account's IDENTITIES: an oauth session counts only when
  // the account holds a trusted-provider (google) identity that asserts email_verified === true for the account's own address.
  // An entry that does name a provider must name a trusted one. Hosted providers are email + Google only, so an oauth amr is Google.
  const oauth = amr.filter((e) => e.method === "oauth" && (e.provider === undefined || e.provider === null || OAUTH_PROVIDERS.has(norm(e.provider))));
  if (oauth.length > 0) {
    for (const identity of user?.identities ?? []) {
      if (!OAUTH_PROVIDERS.has(norm(identity.provider))) continue;
      const data = identity.identity_data ?? null;
      if (data && data.email_verified === true && norm(data.email) === email) return "oauth_verified";
    }
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
