import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  validateTreatmentImagePath,
  buildTreatmentImageThumbPath,
} from "@/lib/images/treatment-images";

// FETT photos (HON-43): the ONE server-side signer for a treatment photo URL.
// Both callers resolve the studio from the authenticated session first, then
// call this:
//   * getTreatmentImageSignedUrlAction ("View larger"), studio scope;
//   * GET /api/clients/[clientId]/images/[imageId]/signed-url (the grid,
//     profile ID photo and visit-chart re-mint), which ALSO passes the
//     clientId from its path, so it is strictly narrower than the action.
//
// Authorization (unchanged from PR #271/#276): the row is read through the
// caller's RLS client, scoped to the session's studio (and the client, when
// given) and not archived. validateTreatmentImagePath then binds the stored
// path to that studio and client. Only then does the SERVICE-ROLE storage
// client sign, and only the path that verified read returned. Nothing here
// takes a bucket or path from input.
//
// Every refusal returns the SAME result ("Image not available."), so a caller
// cannot tell a missing image from one in another studio or another client.
// Nothing here logs a signed URL or a storage path.

export type SignedUrlResult = { ok: true; url: string } | { ok: false; error: string };

export const IMAGE_NOT_AVAILABLE = "Image not available.";

export async function signTreatmentImageUrl(
  studioId: string,
  input: {
    imageId: string;
    /** When given, the row's client AND the path's client segment must equal it. */
    clientId?: string;
    variant?: "original" | "thumb";
  },
  alertRoute = "/clients/[id]/images",
): Promise<SignedUrlResult> {
  const refused: SignedUrlResult = { ok: false, error: IMAGE_NOT_AVAILABLE };
  try {
    const supabase = await createClient();
    // Re-check ownership: the row must belong to the caller's studio and not be
    // archived. The bucket/path are read FROM the verified row, never input.
    let query = supabase
      .from("treatment_images")
      .select("storage_bucket, storage_path, studio_id, client_id")
      .eq("id", input.imageId)
      .eq("studio_id", studioId)
      .is("deleted_at", null);
    if (input.clientId !== undefined) query = query.eq("client_id", input.clientId);
    const { data: row, error } = await query.maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return refused;

    // Trust boundary (PR #276): NEVER sign a path that does not bind to the
    // caller's studio + client. With a clientId, the path's client segment is
    // bound to THAT (the request's client), not merely to the row's.
    // Rejects forged/malformed/cross-studio rows before the service-role
    // signer touches storage.
    const pathCheck = validateTreatmentImagePath({
      expectedStudioId: studioId,
      rowStudioId: row.studio_id,
      rowClientId: input.clientId ?? row.client_id,
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    });
    if (!pathCheck.ok) {
      await recordOpsAlert({
        severity: "critical",
        event: "treatment_image_sign_rejected_invalid_path",
        message: `signer rejected row: ${pathCheck.reason}`,
        studioId,
        route: alertRoute,
        safeDetails: { imageId: input.imageId, reason: pathCheck.reason },
      });
      return refused;
    }

    const admin = createAdminClient();
    if (input.variant === "thumb") {
      // AUTHORIZATION CEILING (as on the page): a derivative URL is minted ONLY
      // when the original itself signs, so it can never out-rank its original.
      const { data: original, error: originalErr } = await admin.storage
        .from(row.storage_bucket)
        .createSignedUrl(row.storage_path, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
      if (originalErr || !original?.signedUrl) return refused;
      const thumbPath = buildTreatmentImageThumbPath(row.storage_path);
      if (!thumbPath) return refused;
      const { data: thumb, error: thumbErr } = await admin.storage
        .from(row.storage_bucket)
        .createSignedUrl(thumbPath, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
      // No alert: a legacy photo without a derivative is expected.
      if (thumbErr || !thumb?.signedUrl) return refused;
      return { ok: true, url: thumb.signedUrl };
    }
    const { data: signed, error: signErr } = await admin.storage
      .from(row.storage_bucket)
      .createSignedUrl(row.storage_path, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      await recordOpsAlert({
        severity: "warning",
        event: "treatment_image_sign_failed",
        // PR #285: generic message: a storage signing error can echo the
        // signed URL / path. Central redaction is the backstop.
        message: "Treatment image signed-URL creation failed.",
        studioId,
        route: alertRoute,
        safeDetails: { imageId: input.imageId, bucket: row.storage_bucket },
      });
      return refused;
    }
    return { ok: true, url: signed.signedUrl };
  } catch {
    return refused;
  }
}
