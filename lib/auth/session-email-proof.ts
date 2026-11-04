import type { SupabaseClient } from "@supabase/supabase-js";
import { isAdmin } from "@/lib/admin";
import { databaseLinkProof, linkProofNeedsDatabase, mailboxProofMethod, type LinkProofFunction, type LinkProofRpc, type ProofClaims, type ProofMethod, type ProofUser } from "@/lib/auth/email-proof";

// Server-side readers for the session's mailbox proof. The user comes from getUser() (validated by the auth server) and the
// claims from getClaims() (signature-verified), so neither is read from an unverified cookie. Any failure answers "no proof".

type AuthLike = Pick<SupabaseClient["auth"], "getUser" | "getClaims">;
// `rpc` is the same request-scoped client: for an account whose address changed, the database decides (0291, S-2b).
type ProofClient = { auth: AuthLike; rpc?: LinkProofRpc };

export async function sessionMailboxProof(
  supabase: ProofClient,
  knownUser?: ProofUser,
): Promise<{ user: (ProofUser & { id?: string }) | null; method: ProofMethod }> {
  try {
    let user: ProofUser = knownUser ?? null;
    if (!user) {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return { user: null, method: null };
      user = data.user as unknown as ProofUser;
    }
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    if (claimsError || !claimsData) return { user: user as ProofUser & { id?: string }, method: null };
    const claims = claimsData.claims as ProofClaims;
    const method = mailboxProofMethod(claims, user);
    if (method === null && linkProofNeedsDatabase(claims, user)) {
      const rpc = supabase.rpc ? (fn: LinkProofFunction) => supabase.rpc!(fn) : undefined;
      if (await databaseLinkProof(rpc)) return { user: user as ProofUser & { id?: string }, method: "email_link_or_otp" };
    }
    return { user: user as ProofUser & { id?: string }, method };
  } catch {
    return { user: null, method: null };
  }
}

/**
 * Platform admin = the address is on the ADMIN_EMAILS allowlist AND this session proves control of that mailbox. A matched
 * address alone (lib/admin.ts isAdmin) is NOT enough: an auto-confirmed password account for an admin's address would match.
 */
export async function isProvenPlatformAdmin(
  supabase: ProofClient,
  knownUser?: ProofUser,
): Promise<boolean> {
  try {
    let user: ProofUser = knownUser ?? null;
    if (!user) {
      const { data, error } = await supabase.auth.getUser();
      if (error || !data.user) return false;
      user = data.user as unknown as ProofUser;
    }
    // The cheap allowlist test first: almost every caller is not an operator, and the proof costs an auth-server round trip.
    if (!isAdmin(user?.email ?? null)) return false;
    return (await sessionMailboxProof(supabase, user)).method !== null;
  } catch {
    return false;
  }
}
