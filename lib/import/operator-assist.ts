import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/admin";

// IMPORT-01, immediate launch-safety mitigation for Quick Import.
//
// WHY THIS EXISTS
// confirmImportAction performs three independent statements with no
// transaction and no RPC: insert import_batches, bulk-insert clients,
// bulk-insert imported_treatment_memories. If the third fails, the second has
// already committed. The batch is soft-voided and the failure is reported
// honestly, but the CLIENT ROWS STAY, 0087 forbids hard-deleting a client, so
// there is nothing to roll back to. Worse, a second attempt at the identical
// paste re-reads existing clients (archived rows included), matches those very
// rows as confident duplicates, and SKIPS them: the same file can no longer
// repair the history it failed to write. A studio owner ends up with clients
// carrying no treatment memory and no self-service way to fix it.
//
// The real fix is a staged/transactional/resumable import. That is a large
// system and it is not this change. This is the mitigation that has to hold
// until it exists: an ordinary studio owner must not be able to execute the
// unsafe path at all.
//
// THE BOUNDARY IS THE SERVER, NOT THE UI
// The page hides the paste-and-confirm island from a non-operator, but hiding
// is not a control: a server action is an HTTP endpoint and can be POSTed
// directly. `ownerContext()` in app/(app)/settings/import/actions.ts calls
// requireImportOperator() BEFORE the first write, so a direct invocation is
// refused at the same boundary as a UI click.
//
// WHO COUNTS AS AN OPERATOR
// The existing Hone platform-operator allowlist: `isAdmin` / ADMIN_EMAILS
// (lib/admin.ts), deliberately NOT a new env var (the same call PR #254 made
// for the New Studio Wizard). It is fail-closed in production: with
// ADMIN_EMAILS unset or empty, `isAdmin` returns false for EVERYONE, so the
// unsafe path is simply unreachable rather than defaulting open.
//
// Identity comes from `supabase.auth.getUser()`, never from
// `practitioners.email`. The auth user is verified server-side by Supabase; a
// practitioner row is application data and must never be the thing that
// decides whether the caller is a platform operator.
//
// Operator standing is ADDITIONAL to, never a replacement for, the existing
// active-studio-owner check. An operator still writes through the RLS-backed
// authenticated client and can therefore only ever import into a studio they
// are an active owner of. No service role is introduced here.

/**
 * Is the signed-in user a Hone platform operator?
 *
 * Self-contained on purpose: it resolves the auth user itself rather than
 * accepting one, so no caller can hand it a forged or stale identity.
 */
export async function isImportOperator(): Promise<boolean> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return isAdmin(user?.email);
}

/**
 * The single denial string. The page copy and the action denial have to say
 * the same thing: a truthful page in front of a differently-worded server
 * refusal is how a UI starts lying about what the server did.
 */
export const IMPORT_OPERATOR_ASSISTED_DENIAL =
  "Import is currently operator-assisted. Email support@hone.care and Hone will bring your clients and treatment history over for you.";

/** Support route offered wherever the denial is shown. */
export const IMPORT_SUPPORT_MAILTO =
  "mailto:support@hone.care?subject=Import%20assistance";
