import "server-only";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { readSelectedStudioId } from "@/lib/supabase/selected-studio";
import { isDeskEnabled } from "@/lib/desk/flag";
import { resolveDeskMembership, type ReceptionistRow } from "@/lib/desk/membership";

// The ONLY identity guard the desk routes use. requirePractitionerWithStudio() is untouched: a receptionist-only user
// is still sent to /no-access by every app page. Reads studio_receptionists through the signed-in client, so row-level
// security still decides (a user reads their own row). No studio row is read: the desk needs the studio id and the
// receptionist's own display name, nothing else.
//
// One identity read per request (React cache): the token is validated on every request, the rows are not trusted
// across requests, and the selected-studio cookie is re-read and re-validated against the rows on every call. An
// inactive or removed receptionist therefore fails the very next request.

export type DeskIdentity = { studioId: string; receptionistId: string; displayName: string };

type DeskRows = { kind: "anonymous" } | { kind: "authenticated"; rows: ReceptionistRow[] };

const loadDeskRows = cache(async (): Promise<DeskRows> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "anonymous" };
  const { data, error } = await supabase.from("studio_receptionists").select("id, studio_id, display_name").eq("user_id", user.id).eq("active", true);
  // A failed read is loud, never "no membership".
  if (error) throw new Error("Failed to load receptionist membership");
  // A fixed order, so the chooser's positional labels ("Studio 1", "Studio 2") mean the same studio on every load and a
  // receptionist cannot open the wrong one because the database returned the rows in another order.
  const rows = [...((data ?? []) as ReceptionistRow[])].sort((a, b) => (a.studio_id < b.studio_id ? -1 : a.studio_id > b.studio_id ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { kind: "authenticated", rows };
});

/**
 * For pages, layouts and server components. Flag off: 404 (the desk does not exist). Then: anonymous -> /login; no
 * active receptionist row -> /no-access; two or more studios with no valid selection -> /desk/choose (the receptionist chooser).
 *
 * A layout's redirect does not stop its page from running, so EVERY desk page and layout calls this itself
 * (tests/desk/desk-source-contract.test.ts pins it).
 */
export async function requireReceptionistWithStudio(): Promise<DeskIdentity> {
  if (!isDeskEnabled()) notFound();
  const identity = await loadDeskRows();
  if (identity.kind === "anonymous") redirect("/login");
  const membership = resolveDeskMembership(identity.rows, await readSelectedStudioId());
  if (membership.kind === "none") redirect("/no-access");
  if (membership.kind === "choose") redirect("/desk/choose");
  return membership.value;
}

/**
 * For the studio chooser page and its action only. Flag off: 404. Anonymous -> /login. No active receptionist row ->
 * /no-access. Exactly one studio -> /desk (a single studio never sees the chooser). Otherwise the user's ACTIVE
 * receptionist rows, read through the signed-in client, which is the only list the chooser may show.
 */
export async function requireReceptionistChoice(): Promise<ReceptionistRow[]> {
  if (!isDeskEnabled()) notFound();
  const identity = await loadDeskRows();
  if (identity.kind === "anonymous") redirect("/login");
  if (identity.rows.length === 0) redirect("/no-access");
  if (identity.rows.length === 1) redirect("/desk");
  return identity.rows;
}
