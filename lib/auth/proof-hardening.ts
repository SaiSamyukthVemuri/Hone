import { randomBytes } from "node:crypto";

// PRE-ACCOUNT TAKEOVER hardening (2 Nov). Hone never sets a password: login is a one-time email link/code or Google. So any auth
// user with a password was created through the Supabase API directly, and if it was created while "Confirm email" was OFF it may
// belong to someone who does NOT control the mailbox (they registered the victim's address with a password in advance). When the
// real owner later proves the mailbox (magic link or verified Google), Supabase links that proof to the SAME account, and the
// registrant's password would still work on it.
//
// So the first time an account proves its mailbox, once: replace the password with a random one nobody knows (the app has no
// password login, so this removes nothing legitimate) and revoke every OTHER session. The attacker's password session and any
// refresh token die. MEASURED on GoTrue (2 Nov, isolated stack): an admin password change revokes EVERY session of the user,
// including the one that just proved the mailbox, so the caller must re-establish a session afterwards (reissueProvenSession).
// A marker in app_metadata makes the rotation one-time, so a legitimate second-device login is never signed out by it.

export const HARDENED_MARKER = "email_proof_hardened_at";

// ROLLOUT SWITCH (Sam, 2 Nov): account-wide remediation (password reset, every session revoked) never activates without a
// separately approved rollout. HONE_PROOF_HARDENING selects it and DEFAULTS TO OFF (unset, empty or any unknown value = off):
//   off           do nothing at all: no read of the account, no marker, no admin call, no session change.
//   password_only touch ONLY an account that has a password set (the pre-registration exposure). An account whose password
//                 state cannot be determined is NOT touched.
//   all           every account on its first proven sign-in.
// It only ever changes the auth account (password, marker, sessions). It never reads or changes a studio membership, and studio
// staff removal never calls it: removing someone from one studio signs nobody out globally.
export type HardeningMode = "off" | "password_only" | "all";
export function hardeningMode(raw: string | undefined | null): HardeningMode {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "password_only" || v === "all" ? v : "off";
}

type AdminAuth = {
  auth: {
    admin: {
      updateUserById: (id: string, attrs: { password?: string; app_metadata?: Record<string, unknown> }) => Promise<{ error: unknown }>;
      generateLink: (p: { type: "magiclink"; email: string }) => Promise<{ data: { properties?: { hashed_token?: string } | null } | null; error: unknown }>;
    };
  };
};

export type HardeningResult = "hardened" | "already_hardened" | "failed";

export async function hardenAccountAfterMailboxProof(
  admin: AdminAuth,
  user: { id: string; app_metadata?: Record<string, unknown> | null },
  now: () => Date = () => new Date(),
): Promise<HardeningResult> {
  const meta = user.app_metadata ?? {};
  if (typeof meta[HARDENED_MARKER] === "string") return "already_hardened";
  try {
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: randomBytes(48).toString("base64url"),
      app_metadata: { ...meta, [HARDENED_MARKER]: now().toISOString() },
    });
    return error ? "failed" : "hardened";
  } catch {
    return "failed";
  }
}

/**
 * After a password rotation every session is gone, so mint a fresh one for the person who JUST proved the mailbox in this very
 * request: a server-generated magic-link token (never emailed, never leaves the server) redeemed on the request's cookie client.
 * The new session's amr is `magiclink`, which is the proof they already presented. false = no session; the caller sends them to
 * sign in again (safe, never a half state).
 */
export async function reissueProvenSession(
  admin: AdminAuth,
  supabase: { auth: { verifyOtp: (p: { token_hash: string; type: "magiclink" }) => Promise<{ error: unknown }> } },
  email: string,
): Promise<boolean> {
  try {
    const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const tokenHash = data?.properties?.hashed_token;
    if (error || !tokenHash) return false;
    const { error: verifyError } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: "magiclink" });
    return !verifyError;
  } catch {
    return false;
  }
}

type PasswordProbe = { rpc: (fn: "auth_account_has_password", args: { p_user_id: string }) => PromiseLike<{ data: unknown; error: unknown }> };

/**
 * Whether the account has a password set, WITHOUT reading the hash. GoTrue's admin user object does not expose it, and an
 * email identity exists for passwordless (OTP-created) users too, so neither can tell. The only server-side signal is a
 * service-role-only function returning a boolean (held proposal 0291, docs/proposals): true/false, or null when unknown (the
 * function does not exist yet, or the call failed). null is treated as "do not touch".
 */
export async function accountHasPassword(admin: PasswordProbe, userId: string): Promise<boolean | null> {
  try {
    const { data, error } = await admin.rpc("auth_account_has_password", { p_user_id: userId });
    if (error) return null;
    return typeof data === "boolean" ? data : null;
  } catch {
    return null;
  }
}

export type HardeningOutcome =
  | "skipped_off"
  | "skipped_no_password"
  | "skipped_password_unknown"
  | "already_hardened"
  | "hardened_session_reissued"
  | "hardened_reissue_failed"
  | "failed";

/**
 * The single entry point the callback uses. Call it only AFTER the session proved mailbox control. `makeAdmin` is invoked only
 * when the mode is not `off`, so `off` constructs nothing and touches nothing.
 */
export async function applyProofHardening(args: {
  mode: HardeningMode;
  user: { id: string; email?: string | null; app_metadata?: Record<string, unknown> | null };
  makeAdmin: () => AdminAuth & PasswordProbe;
  supabase: { auth: { verifyOtp: (p: { token_hash: string; type: "magiclink" }) => Promise<{ error: unknown }> } };
}): Promise<HardeningOutcome> {
  const { mode, user } = args;
  if (mode === "off") return "skipped_off";
  try {
    const admin = args.makeAdmin();
    if (typeof (user.app_metadata ?? {})[HARDENED_MARKER] === "string") return "already_hardened";
    if (mode === "password_only") {
      const has = await accountHasPassword(admin, user.id);
      if (has === null) return "skipped_password_unknown";
      if (!has) return "skipped_no_password";
    }
    const result = await hardenAccountAfterMailboxProof(admin, user);
    if (result === "already_hardened") return "already_hardened";
    if (result !== "hardened") return "failed";
    if (!user.email) return "hardened_reissue_failed";
    return (await reissueProvenSession(admin, args.supabase, user.email)) ? "hardened_session_reissued" : "hardened_reissue_failed";
  } catch {
    return "failed";
  }
}
