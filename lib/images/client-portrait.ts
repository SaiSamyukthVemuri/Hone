import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  validateTreatmentImagePath,
} from "@/lib/images/treatment-images";

// FETT photos (HON-43), 0231: a short-lived signed URL for a client's
// identification portrait, or null.
//
// The SAME trust boundary as the Photos tab (PR #273/#276):
//   1. the row is read through the RLS client, scoped to this studio + client,
//      and must still be a current CLIENT-SCOPED photo (the database already
//      guarantees this for the pointer; re-checking costs nothing);
//   2. the path must bind to this studio + client (validateTreatmentImagePath);
//   3. only then does the admin client sign it, with the same 60 s TTL.
// Any failure is null: the header simply shows no portrait.
export async function signedClientPortraitUrl(input: {
  studioId: string;
  clientId: string;
  portraitImageId: string | null | undefined;
}): Promise<string | null> {
  if (!input.portraitImageId) return null;
  try {
    const supabase = await createClient();
    const { data: row, error } = await supabase
      .from("treatment_images")
      .select("studio_id, client_id, storage_bucket, storage_path")
      .eq("id", input.portraitImageId)
      .eq("studio_id", input.studioId)
      .eq("client_id", input.clientId)
      .is("session_id", null)
      .is("session_block_id", null)
      .is("deleted_at", null)
      .maybeSingle();
    if (error || !row) return null;
    const ok = validateTreatmentImagePath({
      expectedStudioId: input.studioId,
      rowStudioId: row.studio_id,
      rowClientId: row.client_id,
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    }).ok;
    if (!ok) return null;
    const { data } = await createAdminClient()
      .storage.from(TREATMENT_IMAGES_BUCKET)
      .createSignedUrl(row.storage_path, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
    return data?.signedUrl ?? null;
  } catch {
    return null;
  }
}
