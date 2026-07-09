"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { setSelectedStudioId } from "@/lib/supabase/selected-studio";

// Self-contained sign-out for the invite-only /no-access gate (PR #253),
// so the (auth) route does not import (app) internals. Same behaviour as
// the dashboard sign-out: end the Supabase session, return to /login.
export async function signOutFromGate() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// Studio chooser action for multi-studio users (PR 2). Sets the
// hone_selected_studio cookie ONLY after verifying, server-side, that the
// signed-in user is an ACTIVE practitioner in the requested studio — so the
// cookie can never point at a studio the user is not an active member of.
// The lookup is user-scoped + RLS-scoped, and (studio_id, user_id) is unique
// (so .maybeSingle() is safe here). On success, redirect to the dashboard.
export async function switchStudioAction(formData: FormData): Promise<void> {
  const studioId = formData.get("studio_id");
  if (typeof studioId !== "string" || studioId.length === 0) {
    redirect("/no-access?reason=multiple-studios");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data: membership } = await supabase
    .from("practitioners")
    .select("id")
    .eq("user_id", user.id)
    .eq("studio_id", studioId)
    .eq("active", true)
    .maybeSingle();

  if (!membership) {
    // Not an active member of that studio — never set the cookie; back to chooser.
    redirect("/no-access?reason=multiple-studios");
  }

  await setSelectedStudioId(studioId as string);
  redirect("/dashboard");
}
