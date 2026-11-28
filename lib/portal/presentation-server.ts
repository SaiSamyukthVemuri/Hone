import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { dbErrorCode } from "@/lib/logging/error-class";
import { parsePortalPresentation, type PortalPresentation } from "./presentation";

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Only explicit studio UUIDs can enroll. Deployment default is the existing portal. */
export function portalRedesignEnrolled(studioId: string): boolean {
  return uuid.test(studioId) && (process.env.HONE_PORTAL_REDESIGN_STUDIO_IDS ?? "")
    .split(",").some((entry) => entry.trim().toLowerCase() === studioId.toLowerCase());
}

/** The portal route passes its resolved session's studio. Never read drafts through the portal client. */
export async function getPublishedPortalPresentation(studioId: string): Promise<PortalPresentation | null> {
  if (!portalRedesignEnrolled(studioId)) return null;
  try {
    const { data, error } = await createAdminClient().from("studio_portal_presentations")
      .select("published").eq("studio_id", studioId).maybeSingle();
    if (error) throw error;
    if (data?.published == null) return null;
    const presentation = parsePortalPresentation(data.published);
    if (!presentation) console.warn("portal_presentation_invalid");
    return presentation;
  } catch (error) {
    console.warn("portal_presentation_read_failed", dbErrorCode(error));
    return null;
  }
}
