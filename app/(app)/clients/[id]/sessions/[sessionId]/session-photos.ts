import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getSessionBlockAreasByBlockIds } from "@/lib/supabase/queries";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  validateTreatmentImagePath,
} from "@/lib/images/treatment-images";
import { treatmentPhotoAreaLabel, type SessionBlockAreaInput } from "../../images/photo-context";

// FETT photos (HON-43): the photos attached to ONE visit, for that visit's
// chart page. Read-only.
//
// The SAME trust boundary as the Photos tab (PR #273/#276), per photo:
//   1. rows are read through the RLS client, scoped to this studio + client +
//      session, unarchived;
//   2. each path must bind to this studio + client (validateTreatmentImagePath);
//   3. only then does the admin client sign it, with the same 60 s TTL.
// A photo that fails any step is DROPPED, never shown unsigned; a read failure
// yields [] and the section does not render. Area labels are composed exactly
// as the Photos tab composes them, including 0128's structured multi-area set.

export type SessionPhoto = {
  id: string;
  url: string;
  areaLabel: string | null;
  note: string | null;
};

export async function signedSessionPhotos(input: {
  studioId: string;
  clientId: string;
  sessionId: string;
}): Promise<SessionPhoto[]> {
  try {
    const supabase = await createClient();
    const { data: rows, error } = await supabase
      .from("treatment_images")
      .select(
        "id, studio_id, client_id, storage_bucket, storage_path, session_block_id, practitioner_note, session_blocks ( primary_area, side, custom_area_detail )",
      )
      .eq("studio_id", input.studioId)
      .eq("client_id", input.clientId)
      .eq("session_id", input.sessionId)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });
    if (error || !rows || rows.length === 0) return [];

    const areasByBlock = await getSessionBlockAreasByBlockIds(
      rows.map((r) => r.session_block_id).filter((x): x is string => Boolean(x)),
      input.studioId,
    );
    const admin = createAdminClient();
    const signed = await Promise.all(
      rows.map(async (r): Promise<SessionPhoto | null> => {
        const ok = validateTreatmentImagePath({
          expectedStudioId: input.studioId,
          rowStudioId: r.studio_id,
          rowClientId: r.client_id,
          storageBucket: r.storage_bucket,
          storagePath: r.storage_path,
        }).ok;
        if (!ok) return null;
        try {
          const { data } = await admin.storage
            .from(TREATMENT_IMAGES_BUCKET)
            .createSignedUrl(r.storage_path, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
          if (!data?.signedUrl) return null;
          const rawBlock = Array.isArray(r.session_blocks)
            ? (r.session_blocks[0] ?? null)
            : (r.session_blocks ?? null);
          const block = (
            rawBlock
              ? {
                  ...rawBlock,
                  structured_areas: r.session_block_id
                    ? (areasByBlock.get(r.session_block_id) ?? [])
                    : [],
                }
              : null
          ) as SessionBlockAreaInput;
          return {
            id: r.id,
            url: data.signedUrl,
            areaLabel: treatmentPhotoAreaLabel(r.session_block_id, block),
            note: r.practitioner_note ?? null,
          };
        } catch {
          return null;
        }
      }),
    );
    return signed.filter((p): p is SessionPhoto => p !== null);
  } catch {
    return [];
  }
}
