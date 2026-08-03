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
  TREATMENT_IMAGE_MAX_BYTES,
  validateTreatmentImageUpload,
  validateTreatmentImagePath,
  sanitizeFilename,
  buildTreatmentImagePath,
} from "@/lib/images/treatment-images";
import { sanitizeTreatmentImage } from "@/lib/images/treatment-image-sanitize";
import { TREATMENT_NOTE_MAX_LENGTH } from "./note-constants";

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
  // `studio` is still needed for the storage path and the ops alerts; the
  // uploading practitioner is now derived by the command from auth.uid().
  const { studio } = await getCurrentPractitionerWithStudio();

  const clientId = String(formData.get("clientId") ?? "");
  const file = formData.get("file");
  if (!clientId || !(file instanceof File)) {
    return { ok: false, error: "Missing image or client." };
  }

  // PR #284: optional attach-at-upload context. The browser may submit a
  // session and/or session-block id, but these are NEVER trusted — they are
  // validated server-side below (session ∈ studio+client; block ∈ session+
  // studio) before being stored. Empty string → not attached.
  const requestedSessionId = String(formData.get("sessionId") ?? "").trim();
  const requestedSessionBlockId = String(
    formData.get("sessionBlockId") ?? "",
  ).trim();

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

    // PR #284: resolve + VALIDATE the attach context server-side. The 0093
    // trigger is the structural DB backstop (it rejects a cross-tenant /
    // mismatched parent on insert), but we validate here too so a forged id
    // returns a clean generic error instead of a DB exception, and so only
    // proven-consistent ids are ever stored. Mirrors the trigger's predicates:
    //   * session (if any) must belong to this studio + client,
    //   * block (if any) must belong to the SAME session + studio (and a block
    //     can never be attached without its session).
    let sessionId: string | null = null;
    let sessionBlockId: string | null = null;
    if (requestedSessionBlockId) {
      // A block attach requires its session. Derive it from the block row so a
      // mismatched (block, session) pair cannot be stored even if both were
      // submitted.
      const { data: block, error: blockErr } = await supabase
        .from("session_blocks")
        .select("id, session_id, sessions!inner ( id, studio_id, client_id )")
        .eq("id", requestedSessionBlockId)
        .eq("studio_id", studio.id)
        .maybeSingle();
      if (blockErr) throw new Error(blockErr.message);
      const parent = block
        ? (Array.isArray(block.sessions) ? block.sessions[0] : block.sessions)
        : null;
      if (
        !block ||
        !parent ||
        parent.studio_id !== studio.id ||
        parent.client_id !== clientId
      ) {
        return { ok: false, error: "That treatment area is not available for this client." };
      }
      // If the form also sent a session id, it must match the block's session.
      if (requestedSessionId && requestedSessionId !== block.session_id) {
        return { ok: false, error: "That treatment area is not available for this client." };
      }
      sessionId = block.session_id;
      sessionBlockId = block.id;
    } else if (requestedSessionId) {
      const { data: session, error: sessErr } = await supabase
        .from("sessions")
        .select("id")
        .eq("id", requestedSessionId)
        .eq("studio_id", studio.id)
        .eq("client_id", clientId)
        .maybeSingle();
      if (sessErr) throw new Error(sessErr.message);
      if (!session) {
        return { ok: false, error: "That session is not available for this client." };
      }
      sessionId = session.id;
    }

    // CONTENT validation + metadata strip (PR #277). Decodes the actual bytes
    // (never trusts file.type), rejects fake-MIME / SVG / HEIC / PDF / HTML /
    // corrupt data, and re-encodes WITHOUT EXIF/GPS/metadata. Everything below
    // uses the SANITIZED output: its content type drives the path/extension, its
    // bytes are what we upload, its length is the stored size. A normal user
    // mistake (wrong file) just returns the generic error — no ops alert.
    const inputBytes = Buffer.from(await file.arrayBuffer());
    // PR #292 defense-in-depth: the pre-buffer gate trusted the client-reported
    // file.size. Re-bound the ACTUAL buffered length (> 0 and <= 15 MB) on the
    // real bytes BEFORE any Sharp work — independent of file.size — reusing the
    // same single-source validator + constant + generic error strings.
    const bufferValid = validateTreatmentImageUpload({
      contentType: valid.contentType,
      sizeBytes: inputBytes.byteLength,
    });
    if (!bufferValid.ok) return { ok: false, error: bufferValid.error };

    const sanitized = await sanitizeTreatmentImage({
      bytes: inputBytes,
      declaredContentType: valid.contentType,
    });
    if (!sanitized.ok) return { ok: false, error: sanitized.error };

    // PR #292: cap the SANITIZED OUTPUT size before any storage work. The
    // re-encode is bounded by the 100 MP pixel limit, not by the 15 MB byte cap;
    // enforce the byte cap on the output too so a re-encode that grows past the
    // limit is never uploaded or recorded. Generic error — no provider detail.
    if (sanitized.bytes.byteLength > TREATMENT_IMAGE_MAX_BYTES) {
      return { ok: false, error: "Could not upload the image." };
    }

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
        // PR #285: generic message — the event already says what failed, and a
        // raw storage error.message can carry a storage path / signed URL. The
        // central redactor in recordOpsAlert is the real backstop; this keeps
        // the alert clean at the source. The provider error code stays in the
        // structured server log, not the durable alert.
        message: "Treatment image upload to storage failed.",
        studioId: studio.id,
        clientId,
        route: "/clients/[id]/images",
        safeDetails: { imageId: id, bucket: TREATMENT_IMAGES_BUCKET },
      });
      return { ok: false, error: "Could not store the image. Please retry." };
    }

    // METADATA plane (L18 Phase 4): recorded through create_treatment_image_metadata
    // (migration 0168) on the AUTHENTICATED client. studio_id and uploaded_by are
    // no longer sent — the command derives both from auth.uid() — and it re-derives
    // the expected storage path from (studio, client, id) so a forged path cannot
    // point at another tenant's prefix.
    //
    // This is a SEPARATE plane from the storage upload above and the two cannot
    // share a transaction, so the compensating cleanup below stays exactly as it
    // was. Nothing here makes the upload atomic.
    const { error: insErr } = await supabase.rpc("create_treatment_image_metadata", {
      p_id: id,
      p_client_id: clientId,
      p_session_id: sessionId,
      p_session_block_id: sessionBlockId,
      p_storage_bucket: TREATMENT_IMAGES_BUCKET,
      p_storage_path: storagePath,
      p_original_filename: sanitizeFilename(file.name),
      p_content_type: sanitized.contentType,
      p_size_bytes: sanitized.bytes.length,
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
        // PR #285: generic message (the event names the failure). A raw
        // Supabase error.message can carry the storage path / column data;
        // central redaction is the backstop.
        message: rmErr
          ? "Treatment image orphan-object cleanup failed after a metadata insert failure."
          : "Treatment image metadata insert failed.",
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
        // PR #285: generic message — a storage signing error can echo the
        // signed URL / path. Central redaction is the backstop.
        message: "Treatment image signed-URL creation failed.",
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

// PR #307: add / edit / clear the practitioner note under a treatment photo.
// Metadata-only UPDATE via the RLS client (createClient) — no service-role, no
// storage/token/sanitizer touch. Scoped exactly like archiveTreatmentImageAction
// (id + studio_id + client_id + not-already-deleted, with a .select("id")
// row-affected check) so a same-studio cross-client write is a generic
// "not found". The 0093 integrity trigger freezes only identity columns, so a
// practitioner_note update passes. Errors are generic; nothing sensitive logged.
export async function updateTreatmentImageNoteAction(input: {
  imageId: string;
  clientId: string;
  note: string;
}): Promise<ImageActionResult> {
  // Auth gate only: the command derives the studio from auth.uid(). Keeping
  // this call preserves the existing unauthenticated/non-member behaviour.
  await getCurrentPractitionerWithStudio();
  try {
    const trimmed = typeof input.note === "string" ? input.note.trim() : "";
    if (trimmed.length > TREATMENT_NOTE_MAX_LENGTH) {
      return {
        ok: false,
        error: `Note is too long (max ${TREATMENT_NOTE_MAX_LENGTH} characters).`,
      };
    }
    // Whitespace-only clears the note (stored as NULL).
    const value = trimmed.length > 0 ? trimmed : null;

    const supabase = await createClient();
    // L18 Phase 4: the same scoping (id + studio + client + not archived) now
    // lives inside set_treatment_image_note (migration 0168). The studio is
    // derived from auth.uid() rather than supplied. A NULL return means no row
    // matched — missing, wrong client, or already archived — which stays a
    // generic "not found" so it never reveals another client's image.
    const { data, error } = await supabase.rpc("set_treatment_image_note", {
      p_image_id: input.imageId,
      p_client_id: input.clientId,
      p_note: value,
    });
    if (error) throw new Error(error.message);
    if (!data) {
      return { ok: false, error: "Treatment photo not found." };
    }
    revalidatePath(`/clients/${input.clientId}/images`);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save the note. Please try again." };
  }
}

export async function archiveTreatmentImageAction(input: {
  imageId: string;
  clientId: string;
}): Promise<ImageActionResult> {
  // Auth gate only: the command derives BOTH the studio and the archiving
  // practitioner from auth.uid().
  await getCurrentPractitionerWithStudio();
  try {
    const supabase = await createClient();
    // PR #287: archive must change exactly the CURRENT client's row. The
    // conditional UPDATE is scoped by id + studio_id + client_id + not-already-
    // deleted, and `.select("id")` proves a row was actually changed. Without
    // the client_id scope, a Client A route call with Client B's (same-studio)
    // image id would archive the wrong client's photo (RLS/0093 allow the
    // same-studio deleted_at flip); without the row-affected check, a
    // nonexistent / already-archived / wrong-client id would update zero rows
    // and still report success. A zero-row result is a generic "not found" —
    // it never reveals whether another client's image exists.
    // L18 Phase 4: archive_treatment_image (migration 0168) keeps the exact
    // scoping and adds two things the direct write could not: deleted_at is
    // generated by the DATABASE and deleted_by is derived from auth.uid(), so an
    // archive cannot be attributed to another practitioner. Still SOFT only —
    // no row and no storage object is deleted. A NULL return is the generic
    // "not found" for missing / wrong-client / already-archived.
    const { data, error } = await supabase.rpc("archive_treatment_image", {
      p_image_id: input.imageId,
      p_client_id: input.clientId,
    });
    if (error) throw new Error(error.message);
    if (!data) {
      return { ok: false, error: "Treatment photo not found." };
    }
    revalidatePath(`/clients/${input.clientId}/images`);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not archive the image." };
  }
}
