import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { readSelectedStudioId } from "@/lib/supabase/selected-studio";
import {
  resolveReceptionistMembership,
  type ReceptionistMembershipRow,
} from "./membership";

// STUDIO-READY-02d (#824): the route guard for /front-desk, and the ONLY way a
// receptionist reaches the app.
//
// It is the receptionist twin of requirePractitionerWithStudio, with the same
// redirects. A practitioner who opens /front-desk has no receptionist row, so
// they land on /no-access, which sends any user with a studio to /dashboard.
//
// What a receptionist is given is deliberately small:
//   * their own membership row (the 0216 self-select policy);
//   * the studio's NAME and TIMEZONE, read with the service role ONLY AFTER the
//     membership is verified. A receptionist holds no studios read under RLS,
//     and nothing else on the row is fetched;
//   * the three 0216 projections, called with the receptionist's own session,
//     so the database derives the actor from auth.uid() (lib/receptionist/
//     projections.ts).
//
// Membership is re-read on every request: there is no cached capability, so a
// deactivation takes effect on the next page load or action.

export type ReceptionistWithStudio = {
  receptionist: { id: string; displayName: string };
  studio: { id: string; name: string; timezone: string };
};

async function loadOwnRows(): Promise<{ userId: string; rows: ReceptionistMembershipRow[] } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data, error } = await supabase
    .from("studio_receptionists")
    .select("id, studio_id, display_name")
    .eq("user_id", user.id)
    .eq("active", true);
  // A failed read stays loud. It must never become a quiet "no access".
  if (error) throw new Error(`receptionist_membership_read_failed:${error.code ?? "unknown"}`);
  return { userId: user.id, rows: (data ?? []) as ReceptionistMembershipRow[] };
}

export async function requireReceptionistWithStudio(): Promise<ReceptionistWithStudio> {
  const loaded = await loadOwnRows();
  if (!loaded) redirect("/login");

  const membership = resolveReceptionistMembership(loaded.rows, await readSelectedStudioId());
  if (membership.kind === "none") redirect("/no-access");
  if (membership.kind === "choose") redirect("/no-access?reason=multiple-studios");

  const { value } = membership;
  const admin = createAdminClient();
  const { data: studio, error } = await admin
    .from("studios")
    .select("id, name, timezone")
    .eq("id", value.studio_id)
    .single();
  if (error || !studio) throw new Error("receptionist_studio_read_failed");

  return {
    receptionist: { id: value.id, displayName: value.display_name },
    studio: {
      id: studio.id as string,
      name: studio.name as string,
      timezone: studio.timezone as string,
    },
  };
}
