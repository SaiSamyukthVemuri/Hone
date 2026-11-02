import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readSelectedStudioId } from "@/lib/supabase/selected-studio";
import { isDeskEnabled } from "@/lib/desk/flag";
import { resolveDeskMembership, type ReceptionistRow } from "@/lib/desk/membership";

// The ONLY identity guard the desk routes use. requirePractitionerWithStudio() is untouched: a
// receptionist-only user is still sent to /no-access by every app page (and the reverse holds
// here). Reads studio_receptionists through the signed-in client, so row-level security still
// decides (a user reads their own row). No studio row is read: the desk needs the studio id and the
// receptionist's own display name, nothing else.
//
// One identity read per request (React cache): the token is still validated on every request, the
// rows are not trusted across requests, and the selected-studio cookie is re-read and re-validated
// against the rows on every call.

export type DeskIdentity = { studioId: string; receptionistId: string; displayName: string };

type DeskRows = { kind: "anonymous" } | { kind: "authenticated"; rows: ReceptionistRow[] };

const loadDeskRows = cache(async (): Promise<DeskRows> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "anonymous" };
  const { data, error } = await supabase
    .from("studio_receptionists")
    .select("id, studio_id, display_name")
    .eq("user_id", user.id)
    .eq("active", true);
  // A failed read is loud, never "no membership" (the same stance as the practitioner guard).
  if (error) throw new Error("Failed to load receptionist membership");
  return { kind: "authenticated", rows: (data ?? []) as ReceptionistRow[] };
});

/**
 * For pages, layouts and server components. Flag off: 404 (the desk does not exist). Then:
 * anonymous -> /login; no active receptionist row -> /no-access; two or more studios with no valid
 * selection -> /no-access?reason=multiple-studios (never auto-picked).
 *
 * A layout's redirect does not stop its page from running, so EVERY desk page and layout calls this
 * itself (tests/desk/desk-source-contract.test.ts pins it).
 */
export async function requireReceptionistWithStudio(): Promise<DeskIdentity> {
  if (!isDeskEnabled()) notFound();
  const identity = await loadDeskRows();
  if (identity.kind === "anonymous") redirect("/login");
  const membership = resolveDeskMembership(identity.rows, await readSelectedStudioId());
  if (membership.kind === "none") redirect("/no-access");
  if (membership.kind === "choose") redirect("/no-access?reason=multiple-studios");
  return membership.value;
}

/**
 * For server actions: the same resolution, but it THROWS (a redirect raised inside an action's
 * try/catch would be swallowed). Fixed messages only: no value of any kind.
 */
export async function getReceptionistWithStudio(): Promise<DeskIdentity> {
  if (!isDeskEnabled()) throw new Error("Desk unavailable");
  const identity = await loadDeskRows();
  if (identity.kind === "anonymous") throw new Error("Not signed in");
  const membership = resolveDeskMembership(identity.rows, await readSelectedStudioId());
  if (membership.kind === "none") throw new Error("No active receptionist membership");
  if (membership.kind === "choose") throw new Error("Studio choice required");
  return membership.value;
}
