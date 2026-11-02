import { randomBytes } from "node:crypto";

// PRE-ACCOUNT TAKEOVER hardening (2 Nov). Hone never sets a password: login is a one-time email link/code or Google. So any auth
// user with a password was created through the Supabase API directly, and if it was created while "Confirm email" was OFF it may
// belong to someone who does NOT control the mailbox (they registered the victim's address with a password in advance). When the
// real owner later proves the mailbox (magic link or verified Google), Supabase links that proof to the SAME account, and the
// registrant's password would still work on it.
//
// So the first time an account proves its mailbox, once: replace the password with a random one nobody knows (the app has no
// password login, so this removes nothing legitimate) and revoke every OTHER session. The attacker's password session and any
// refresh token die; the person who just proved the mailbox keeps this session. A marker in app_metadata makes it one-time, so a
// legitimate second-device login is never signed out by it.

export const HARDENED_MARKER = "email_proof_hardened_at";

type AdminAuth = {
  auth: {
    admin: {
      updateUserById: (id: string, attrs: { password?: string; app_metadata?: Record<string, unknown> }) => Promise<{ error: unknown }>;
      signOut: (jwt: string, scope: "global" | "local" | "others") => Promise<{ error: unknown }>;
    };
  };
};

export type HardeningResult = "hardened" | "already_hardened" | "failed";

export async function hardenAccountAfterMailboxProof(
  admin: AdminAuth,
  user: { id: string; app_metadata?: Record<string, unknown> | null },
  accessToken: string,
  now: () => Date = () => new Date(),
): Promise<HardeningResult> {
  const meta = user.app_metadata ?? {};
  if (typeof meta[HARDENED_MARKER] === "string") return "already_hardened";
  try {
    const { error } = await admin.auth.admin.updateUserById(user.id, {
      password: randomBytes(48).toString("base64url"),
      app_metadata: { ...meta, [HARDENED_MARKER]: now().toISOString() },
    });
    if (error) return "failed";
    const revoked = await admin.auth.admin.signOut(accessToken, "others");
    return revoked.error ? "failed" : "hardened";
  } catch {
    return "failed";
  }
}
