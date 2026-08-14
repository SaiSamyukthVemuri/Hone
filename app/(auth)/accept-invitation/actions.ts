"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { clearSelectedStudioId } from "@/lib/supabase/selected-studio";

export type AcceptState = { error: string } | null;

// THE authoritative acceptance point. The browser cannot call the acceptance
// command directly (it is service-role only). This trusted server adapter:
//   1. validates the unchecked-by-default current-policy checkbox;
//   2. resolves the authenticated user from the session;
//   3. calls admin_accept_pending_invitation(p_user_id) via the service-role
//      client, passing ONLY the session user id: the command derives the
//      verified email + current policy versions internally and accepts no
//      email/studio/role/timestamps/versions from the browser.
export async function acceptInvitationAction(
  _prev: AcceptState,
  formData: FormData,
): Promise<AcceptState> {
  const consent = formData.get("consent");
  if (consent !== "on" && consent !== "true") {
    return {
      error:
        "Please confirm you agree to the current Terms of Service and Privacy Policy.",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Service-role acceptance command; the browser cannot reach it.
  const admin = createAdminClient();
  const { data: rec, error } = await admin.rpc(
    "admin_accept_pending_invitation",
    { p_user_id: user.id },
  );
  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  const res = (rec && typeof rec === "object" ? rec : {}) as {
    status?: string;
    choose_studio?: boolean;
  };

  if (res.status === "conflict") redirect("/no-access?reason=invite-conflict");
  if (res.status === "ambiguous") redirect("/no-access?reason=invite-ambiguous");
  if (res.status === "no_invitation") redirect("/no-access");

  // linked / already_linked. Force the chooser for a newly multi-studio user.
  if (res.choose_studio === true) {
    await clearSelectedStudioId();
  }
  redirect("/dashboard");
}
