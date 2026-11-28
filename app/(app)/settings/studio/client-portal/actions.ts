"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { parsePortalPresentation } from "@/lib/portal/presentation";
import { portalRedesignEnrolled } from "@/lib/portal/presentation-server";
import { dbErrorCode } from "@/lib/logging/error-class";
import { revalidatePath } from "next/cache";

export type PortalEditResult = { ok: true; revision: number } | { ok: false; error: string; reload?: true };

export async function editPortalPresentation(
  renderedStudioId: string, revision: number, operation: "save" | "publish" | "classic", input?: unknown,
): Promise<PortalEditResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return { ok: false, error: "Only studio owners can change the client portal." };
  if (studio.id !== renderedStudioId || !portalRedesignEnrolled(studio.id)) {
    return { ok: false, error: "Open portal settings from your studio’s owner account." };
  }
  if (!Number.isSafeInteger(revision) || revision < 0 || !["save", "publish", "classic"].includes(operation)) {
    return { ok: false, error: "Reload portal settings and try again." };
  }
  const draft = operation === "save" ? parsePortalPresentation(input) : null;
  if (operation === "save" && !draft) {
    return { ok: false, error: "Each section and the welcome message need a valid heading." };
  }
  const db = await createClient();
  const { data, error } = await db.rpc("edit_studio_portal_presentation", {
    p_studio_id: studio.id, p_revision: revision, p_operation: operation, p_draft: draft,
  });
  if (error || typeof data !== "number") {
    const code = dbErrorCode(error);
    if (code === "40001") return { ok: false, reload: true, error: "These settings changed in another window. Reload before editing again." };
    console.warn("portal_presentation_change_failed", code);
    return { ok: false, reload: true, error: "Could not save your portal settings. Reload to check the latest version." };
  }
  revalidatePath("/settings/studio/client-portal");
  return { ok: true, revision: data };
}
