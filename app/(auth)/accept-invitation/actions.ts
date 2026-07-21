"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { clearSelectedStudioId } from "@/lib/supabase/selected-studio";

export type AcceptState = { error: string } | null;

// Explicit-acceptance submit. Requires the current-policy confirmation checkbox,
// then calls the self-scoped accept RPC (which stamps the ACTUAL transaction
// time + current versions and creates the membership atomically). Routes on the
// result; a multi-studio user is sent through the truthful chooser.
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

  const { data: rec, error } = await supabase.rpc(
    "accept_my_pending_invitation",
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
