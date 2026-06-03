"use server";

import { redirect } from "next/navigation";
import { destroyPortalSession } from "@/lib/portal/session";

// Logout action invoked by the portal home's logout form. Revokes
// the current session DB row (stamps revoked_at) and clears the
// httpOnly cookie. Always redirects to /portal/login so the visitor
// lands on a known-good public surface regardless of session state.
export async function portalLogoutAction(): Promise<void> {
  await destroyPortalSession();
  redirect("/portal/login");
}
