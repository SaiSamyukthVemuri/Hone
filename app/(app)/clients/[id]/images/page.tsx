import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getCurrentPractitionerWithStudio,
  getSessionBlockAreasByBlockIds,
} from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  TREATMENT_IMAGES_BUCKET,
  TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
  validateTreatmentImagePath,
} from "@/lib/images/treatment-images";
import {
  treatmentPhotoScopeLabel,
  treatmentPhotoAreaLabel,
  sessionBlockOptionLabel,
  type SessionBlockAreaInput,
} from "./photo-context";
import {
  TreatmentImagesManager,
  type SessionAttachOption,
} from "./TreatmentImagesManager";
import { getPhotoConsentStateForClient } from "@/lib/consent/queries";
import { photoConsentSummary } from "@/lib/consent/signed-record";

// PR #271. Practitioner-only treatment images. Gated by the app shell's
// requirePractitionerWithStudio layout; data is loaded with the RLS client
// scoped to the resolved studio. Image bytes are NEVER served here — only
// metadata; viewing mints a short-TTL signed URL via a server action.
export const dynamic = "force-dynamic";

export default async function ClientImagesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();

  const supabase = await createClient();
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, name")
    .eq("studio_id", studio.id)
    .eq("id", id)
    .maybeSingle();
  if (clientErr) throw new Error(clientErr.message);
  if (!client) notFound();

  // PR #274: also select the existing context links (session_id /
  // session_block_id) and embed the attached session block's structured area
  // fields (primary_area / side / custom_area_detail) so each card can show
  // treatment-context tags. Display-only — no schema change; raw IDs are turned
  // into labels server-side and never sent to the client.
  const { data: images, error: imgErr } = await supabase
    .from("treatment_images")
    .select(
      // sessions ( started_at ) is a read-only embed (via the session_id FK)
      // so the gallery can title a photo with its SESSION date instead of the
      // raw filename. Display-only; no schema/security change.
      "id, original_filename, created_at, storage_bucket, storage_path, session_id, session_block_id, practitioner_note, sessions ( started_at ), session_blocks ( primary_area, side, custom_area_detail )",
    )
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (imgErr) throw new Error(imgErr.message);

  // PR #273: server-side preview signing. Ownership is already verified (the
  // RLS client load above is scoped to this studio + client). Short-TTL signed
  // URLs are returned ONLY in this response — never stored in the DB, never
  // public. storage_path stays server-side; only the signed URL reaches the
  // client. A failed sign yields previewUrl=null → the card shows
  // "Image not available" but keeps the date label + context tags + Archive.
  const meta = (images ?? []) as Array<{
    id: string;
    original_filename: string | null;
    created_at: string;
    storage_bucket: string;
    storage_path: string;
    session_id: string | null;
    session_block_id: string | null;
    practitioner_note: string | null;
    sessions: { started_at: string } | { started_at: string }[] | null;
    session_blocks: SessionBlockAreaInput | SessionBlockAreaInput[];
  }>;
  // Migration 0128: batch-load the structured areas for every attached block so
  // each photo's area tag shows the full multi-area set + laterality.
  const photoAreasByBlock = await getSessionBlockAreasByBlockIds(
    meta
      .map((m) => m.session_block_id)
      .filter((x): x is string => Boolean(x)),
    studio.id,
  );
  const admin = createAdminClient();
  const rows = await Promise.all(
    meta.map(async (m) => {
      let previewUrl: string | null = null;
      // Trust boundary (PR #276): only sign a path that binds to this studio +
      // client; a forged/malformed row yields previewUrl=null ("Image not
      // available") instead of being signed.
      const pathOk = validateTreatmentImagePath({
        expectedStudioId: studio.id,
        rowStudioId: studio.id,
        rowClientId: id,
        storageBucket: m.storage_bucket,
        storagePath: m.storage_path,
      }).ok;
      if (pathOk) {
        try {
          const { data } = await admin.storage
            .from(TREATMENT_IMAGES_BUCKET)
            .createSignedUrl(
              m.storage_path,
              TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS,
            );
          previewUrl = data?.signedUrl ?? null;
        } catch {
          previewUrl = null;
        }
      }
      // Embedded to-one can arrive as an object or a single-element array.
      const rawBlock = Array.isArray(m.session_blocks)
        ? (m.session_blocks[0] ?? null)
        : (m.session_blocks ?? null);
      // Migration 0128: attach the structured area set (keyed by the photo's
      // session_block_id) so the tag shows every treated area, not just the first.
      const block: SessionBlockAreaInput = rawBlock
        ? {
            ...rawBlock,
            structured_areas: m.session_block_id
              ? (photoAreasByBlock.get(m.session_block_id) ?? [])
              : [],
          }
        : null;
      const session = Array.isArray(m.sessions)
        ? (m.sessions[0] ?? null)
        : (m.sessions ?? null);
      // Compute labels server-side; only labels (never raw IDs) reach the client.
      return {
        id: m.id,
        // Session date of the attached session (null for client-scope photos),
        // used as the human card title in place of the raw filename.
        sessionDate: session?.started_at ?? null,
        // PR #307: practitioner note/caption shown under the photo (null = none).
        note: m.practitioner_note ?? null,
        createdAt: m.created_at,
        previewUrl,
        scopeLabel: treatmentPhotoScopeLabel({
          sessionId: m.session_id,
          sessionBlockId: m.session_block_id,
        }),
        areaLabel: treatmentPhotoAreaLabel(m.session_block_id, block),
      };
    }),
  );

  // PR #284: recent sessions (with their blocks' area fields) for the
  // attach-at-upload context selector. RLS-client + studio/client scoped, so a
  // practitioner only ever sees their own studio's sessions for this client.
  // Only ids + display labels reach the client; the upload action re-validates
  // every submitted id server-side. Bounded to keep the dropdown small.
  const { data: sessionRows, error: sessErr } = await supabase
    .from("sessions")
    .select(
      "id, started_at, session_blocks ( id, primary_area, side, custom_area_detail )",
    )
    .eq("studio_id", studio.id)
    .eq("client_id", id)
    .order("started_at", { ascending: false })
    .limit(12);
  if (sessErr) throw new Error(sessErr.message);
  type EmbeddedBlock = { id: string } & NonNullable<SessionBlockAreaInput>;
  // Migration 0128: batch-load structured areas for every block in the selector
  // so each option shows the full multi-area set + laterality.
  const optionAreasByBlock = await getSessionBlockAreasByBlockIds(
    (sessionRows ?? []).flatMap((s) => {
      const raw = s.session_blocks;
      const blocks = (
        Array.isArray(raw) ? raw : raw ? [raw] : []
      ) as unknown as EmbeddedBlock[];
      return blocks.map((b) => b.id);
    }),
    studio.id,
  );
  const sessionOptions: SessionAttachOption[] = (sessionRows ?? []).map((s) => {
    const raw = s.session_blocks;
    const blocks = (
      Array.isArray(raw) ? raw : raw ? [raw] : []
    ) as unknown as EmbeddedBlock[];
    return {
      id: s.id as string,
      startedAt: s.started_at as string,
      blocks: blocks.map((b) => ({
        id: b.id,
        areaLabel: sessionBlockOptionLabel({
          ...b,
          structured_areas: optionAreasByBlock.get(b.id) ?? [],
        }),
      })),
    };
  });

  // P1-A: at-a-glance photo-consent status, right where photos are handled.
  // null = the studio has no active photo-consent template (no banner).
  const photoConsentState = await getPhotoConsentStateForClient(studio.id, id);
  const photoConsent = photoConsentState ? photoConsentSummary(photoConsentState) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link
        href={`/clients/${id}`}
        className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
      >
        ← {client.name}
      </Link>
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Treatment Photos</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Stored privately. Visible to practitioners in this studio.
        </p>
      </header>
      {photoConsent && (
        <p
          role="status"
          className={
            photoConsent.tone === "ok"
              ? "rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-200"
              : photoConsent.tone === "warn"
                ? "rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
                : "rounded-md border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/50 dark:text-neutral-300"
          }
        >
          {photoConsent.label}
        </p>
      )}
      <TreatmentImagesManager
        clientId={id}
        images={rows}
        sessionOptions={sessionOptions}
      />
    </div>
  );
}
