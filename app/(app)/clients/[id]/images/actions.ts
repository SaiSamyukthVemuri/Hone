"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { recordOpsAlert } from "@/lib/ops/alerts";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  validateTreatmentImageUpload,
  validateTreatmentImagePath,
  sanitizeFilename,
  buildTreatmentImagePath,
} from "@/lib/images/treatment-images";
import { sanitizeTreatmentImage } from "@/lib/images/treatment-image-sanitize";

// PR #271. Practitioner-only secure treatment image actions.
//
// Security model (see migration 0092 header): PRIVATE bucket, no public URLs.
// Metadata reads/writes go through the RLS client (createClient) scoped to the
// resolved studio.id; the STORAGE plane (upload + createSignedUrl) goes through
// the SERVICE-ROLE client (createAdminClient) ONLY AFTER this action has
// (a) resolved the studio from the authenticated session and (b) verified the
// target client/row belongs to that studio. The studio.id is NEVER taken from
// client input, and a client-supplied storage path is NEVER signed.

export type ImageActionResult = { ok: true } | { ok: false; error: string };
export type SignedUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string };

export async function uploadTreatmentImageAction(
  formData: FormData,
): Promise<ImageActionResult> {
  // Auth first (may redirect/throw for non-practitioners); never wrapped so a
  // redirect propagates correctly.
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  const clientId = String(formData.get("clientId") ?? "");
  const file = formData.get("file");
  if (!clientId || !(file instanceof File)) {
    return { ok: false, error: "Missing image or client." };
  }

  // Validate BEFORE any I/O. Server-authoritative MIME + size gate.
  const valid = validateTreatmentImageUpload({
    contentType: file.type,
    sizeBytes: file.size,
  });
  if (!valid.ok) return { ok: false, error: valid.error };

  try {
    const supabase = await createClient();
    // Ownership: the client must belong to the caller's studio (RLS-scoped).
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id")
      .eq("studio_id", studio.id)
      .eq("id", clientId)
      .maybeSingle();
    if (clientErr) throw new Error(clientErr.message);
    if (!client) return { ok: false, error: "Client not found." };

    // CONTENT validation + metadata strip (PR #277). Decodes the actual bytes
    // (never trusts file.type), rejects fake-MIME / SVG / HEIC / PDF / HTML /
    // corrupt data, and re-encodes WITHOUT EXIF/GPS/metadata. Everything below
    // uses the SANITIZED output: its content type drives the path/extension, its
    // bytes are what we upload, its length is the stored size. A normal user
    // mistake (wrong file) just returns the generic error — no ops alert.
    const inputBytes = Buffer.from(await file.arrayBuffer());
    const sanitized = await sanitizeTreatmentImage({
      bytes: inputBytes,
      declaredContentType: valid.contentType,
    });
    if (!sanitized.ok) return { ok: false, error: sanitized.error };

    // Server-generated id + studio-prefixed path; client path is never trusted.
    // Extension/content type come from the SANITIZED output, not the upload.
    const id = randomUUID();
    const storagePath = buildTreatmentImagePath({
      studioId: studio.id,
      clientId,
      id,
      contentType: sanitized.contentType,
    });

    // STORAGE plane: service-role upload of the SANITIZED bytes to the private
    // bucket.
    const admin = createAdminClient();
    const { error: upErr } = await admin.storage
      .from(TREATMENT_IMAGES_BUCKET)
      .upload(storagePath, sanitized.bytes, {
        contentType: sanitized.contentType,
        upsert: false,
      });
    if (upErr) {
      await recordOpsAlert({
        severity: "warning",
        event: "treatment_image_upload_failed",
        message: upErr.message,
        studioId: studio.id,
        clientId,
        route: "/clients/[id]/images",
        safeDetails: { imageId: id, bucket: TREATMENT_IMAGES_BUCKET },
      });
      return { ok: false, error: "Could not store the image. Please retry." };
    }

    // METADATA: RLS client insert (studio-scoped; RLS backstops the studio_id).
    const { error: insErr } = await supabase.from("treatment_images").insert({
      id,
      studio_id: studio.id,
      client_id: clientId,
      session_id: null,
      session_block_id: null,
      storage_bucket: TREATMENT_IMAGES_BUCKET,
      storage_path: storagePath,
      original_filename: sanitizeFilename(file.name),
      content_type: sanitized.contentType,
      size_bytes: sanitized.bytes.length,
      uploaded_by: practitioner.id,
    });
    if (insErr) {
      // Cleanup so a failed insert does not orphan the object. If the cleanup
      // itself fails, surface a CRITICAL alert (the object is now orphaned).
      const { error: rmErr } = await admin.storage
        .from(TREATMENT_IMAGES_BUCKET)
        .remove([storagePath]);
      await recordOpsAlert({
        severity: rmErr ? "critical" : "warning",
        event: rmErr
          ? "treatment_image_orphan_cleanup_failed"
          : "treatment_image_metadata_insert_failed",
        message: rmErr ? rmErr.message : insErr.message,
        studioId: studio.id,
        clientId,
        route: "/clients/[id]/images",
        safeDetails: { imageId: id, bucket: TREATMENT_IMAGES_BUCKET },
      });
      return { ok: false, error: "Could not save the image. Please retry." };
    }

    revalidatePath(`/clients/${clientId}/images`);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not upload the image." };
  }
}

export async function getTreatmentImageSignedUrlAction(input: {
  imageId: string;
}): Promise<SignedUrlResult> {
  const { studio } = await getCurrentPractitionerWithStudio();
  try {
    const supabase = await createClient();
    // Re-check ownership: the row must belong to the caller's studio and not be
    // archived. The bucket/path are read FROM the verified row, never input.
    const { data: row, error } = await supabase
      .from("treatment_images")
      .select("storage_bucket, storage_path, studio_id, client_id")
      .eq("id", input.imageId)
      .eq("studio_id", studio.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!row) return { ok: false, error: "Image not available." };

    // Trust boundary (PR #276): NEVER sign a path that does not bind to the
    // caller's studio + the row's client. Rejects forged/malformed/cross-studio
    // rows before the service-role signer touches storage.
    const pathCheck = validateTreatmentImagePath({
      expectedStudioId: studio.id,
      rowStudioId: row.studio_id,
      rowClientId: row.client_id,
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    });
    if (!pathCheck.ok) {
      await recordOpsAlert({
        severity: "critical",
        event: "treatment_image_sign_rejected_invalid_path",
        message: `signer rejected row: ${pathCheck.reason}`,
        studioId: studio.id,
        route: "/clients/[id]/images",
        safeDetails: { imageId: input.imageId, reason: pathCheck.reason },
      });
      return { ok: false, error: "Image not available." };
    }

    const admin = createAdminClient();
    const { data: signed, error: signErr } = await admin.storage
      .from(row.storage_bucket)
      .createSignedUrl(row.storage_path, TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed?.signedUrl) {
      await recordOpsAlert({
        severity: "warning",
        event: "treatment_image_sign_failed",
        message: signErr?.message ?? "no signed url",
        studioId: studio.id,
        route: "/clients/[id]/images",
        safeDetails: { imageId: input.imageId, bucket: row.storage_bucket },
      });
      return { ok: false, error: "Image not available." };
    }
    return { ok: true, url: signed.signedUrl };
  } catch {
    return { ok: false, error: "Image not available." };
  }
}

export async function archiveTreatmentImageAction(input: {
  imageId: string;
  clientId: string;
}): Promise<ImageActionResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("treatment_images")
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: practitioner.id,
      })
      .eq("id", input.imageId)
      .eq("studio_id", studio.id)
      .is("deleted_at", null);
    if (error) throw new Error(error.message);
    revalidatePath(`/clients/${input.clientId}/images`);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not archive the image." };
  }
}
