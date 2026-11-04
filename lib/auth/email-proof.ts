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
export type ProofIdentity = { provider?: unknown; identity_data?: Record<string, unknown> | null; created_at?: unknown; updated_at?: unknown };
export type ProofUser =
  | { email?: string | null; email_change_sent_at?: unknown; identities?: ProofIdentity[] | null }
  | null
  | undefined;

/** Methods whose credential is delivered to the account's own email address. */
// The amr METHOD per flow was MEASURED on real GoTrue (isolated stack, 3 Nov, Confirm email ON and OFF); timestamp ORDERING under
// Confirm ON was not, and is handled by emailChangeState below, not by comparing times (Insurance, 4 Nov):
//   * implicit /verify (link redeemed by token_hash: invite, magic link, signup-confirmation, recovery, email code): `otp`;
//   * PKCE (what the browser sign-in and /auth/callback actually use): a magic link to an EXISTING address is `magiclink` and a
//     recovery link is `recovery`; a PKCE session keeps its amr across refresh (machines/AUTH-PKCE-amr-evidence.json);
//   * PKCE magic link to a NEW address: `magiclink` with Confirm OFF, but `email/signup` with Confirm ON (hosted), because GoTrue
//     mails a signup confirmation for an unconfirmed user (machines/1333-PROBE-RESULTS.md section 3);
//   * a password sign-in AND a password sign-up (Confirm OFF) are `password`.
// So exactly `otp`, `magiclink` and `recovery` count. `email/signup` stays UNPROVEN pending Insurance's decision (analysis in
// auth-worker/1333-RULE-FIX-PACKAGE.md): with Confirm ON a brand-new user who signs in from the login form is asked for one more
// link. `invite` was never observed as an amr method (an invite link is `otp`). Widening the set is a reviewed change, here AND in 0291.
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
 * by link, ask to change the account email to a victim's address, and keep a proven session once the victim confirms.
 *
 * THIS PURE RULE COMPARES NO TIMESTAMPS. Comparing the JWT's whole-second amr timestamp to the change time cannot be made safe
 * (machines/1333-PROBE-RESULTS.md, auth-worker/1333-RULE-FIX-PACKAGE.md): `>=` accepts a session made in the same second BEFORE the
 * change (Codex P1); `>` refuses every first sign-in of a new account (its email identity is written in the same second); and the
 * session GoTrue returns to whoever clicks the LAST confirm link of a double-confirm change (implicit flow: amr `otp`, created ~10 ms
 * AFTER the change) is accepted by `>=` always and by `>` whenever the two straddle a second boundary. So instead:
 *   * an account whose address has NEVER changed (no email_change_sent_at, and every `email` identity's updated_at EQUALS its
 *     created_at; measured equal on every first sign-in: magic link, OTP, PKCE new/existing, recovery, signup confirmation, invite)
 *     keeps its link proof: the address is the one the account was created with, so a link to it proves that mailbox;
 *   * an account with ANY email-change activity gets NO link proof from this rule. Only the database can tell a session created by a
 *     fresh credential sent to the new address from the attacker's (sessions.created_at and the credential issue times at microsecond
 *     precision); that check is held 0291 (#1338), which the app consults for exactly these accounts. Without it they fail closed:
 *     Google still proves, a link does not. Hone has no email-change UI, so no honest flow reaches this state.
 * A value that is present but unreadable, or an email identity without readable created_at/updated_at, counts as CHANGED (fail
 * closed); this also covers a GoTrue/CLI bump that stopped returning the fields.
 */
export type EmailChangeState = "never_changed" | "changed";

/** Microseconds since the epoch of a GoTrue/Postgres timestamp string, or null if it is not one. Keeps all six fraction digits. */
function instantMicros(raw: unknown): bigint | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(raw.trim());
  if (!m) return null;
  const zone = m[3] === "Z" ? "Z" : m[3].length === 3 ? `${m[3]}:00` : m[3].includes(":") ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
  const ms = Date.parse(`${m[1].replace(" ", "T")}${zone}`);
  if (!Number.isFinite(ms)) return null;
  return BigInt(ms) * 1000n + BigInt((m[2] ?? "").padEnd(6, "0").slice(0, 6));
}

export function emailChangeState(user: ProofUser): EmailChangeState {
  const sent = user?.email_change_sent_at;
  if (sent !== undefined && sent !== null && sent !== "") return "changed";
  // EA-1 (Insurance): the identities list must be PRESENT to judge the account never-changed. An absent, null or non-array value
  // (or a non-object entry) is unreadable, so the account counts as changed and only the database can prove it (fail closed). An
  // EMPTY array is real data: an account with no email identity row (e.g. Google-only) whose address has no change activity.
  const identities: unknown = user?.identities;
  if (!Array.isArray(identities)) return "changed";
  for (const identity of identities as unknown[]) {
    if (!identity || typeof identity !== "object") return "changed";
    if (norm((identity as ProofIdentity).provider) !== "email") continue;
    const created = instantMicros((identity as ProofIdentity).created_at);
    const updated = instantMicros((identity as ProofIdentity).updated_at);
    if (created === null || updated === null || created !== updated) return "changed";
  }
  return "never_changed";
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

  if (emailChangeState(user) === "never_changed" && amr.some((e) => typeof e.method === "string" && MAILBOX_METHODS.has(e.method))) {
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
