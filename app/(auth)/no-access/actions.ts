"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Self-contained sign-out for the invite-only /no-access gate (PR #253),
// so the (auth) route does not import (app) internals. Same behaviour as
// the dashboard sign-out: end the Supabase session, return to /login.
export async function signOutFromGate() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
