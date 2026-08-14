"use server";

// Dedicated CONSULTATION notes + SKIN/HAIR ANALYSIS clinical records
// (migration 0126). These are the ONLY authenticated write surfaces for
// client_clinical_notes. Two operations:
//   * addClinicalNoteAction    , create a new dated note of a kind.
//   * reviseClinicalNoteAction , record a revision that supersedes a saved
//                                 note (append-only correction; the original
//                                 is never overwritten).
//
// Contract / safety posture (mirrors the migration comment):
//   * Runs server-side under the user-scoped Supabase client (RLS-enforced).
//     No createAdminClient / service role.
//   * studio_id is trigger-derived from the parent client; the action never
//     trusts a caller-supplied studio. practitioner_id is forced to the
//     signed-in practitioner (attribution cannot be spoofed).
//   * After the insert the action performs a SEPARATE read-back of the
//     persisted row and only reports success once it is confirmed stored with
//     the expected body/kind/client, a false "saved" can never be shown.
//   * A revision races on the (supersedes_note_id) partial-unique index; a
//     second concurrent revision surfaces as a distinct `stale_revision`
//     conflict rather than a silent duplicate. The failure path NEVER retries
//     in a way that could create a duplicate clinical record.
//   * NO email/SMS, NO intake, NO bookings/appointments, NO Stripe/payments,
//     NO portal exposure, NO finalization/correction flags. Additive only.

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type {
  ClientClinicalNote,
  ClinicalNoteKind,
} from "@/lib/types/database";

const MAX_BODY_LENGTH = 20000;
const MAX_AREAS = 40;
const MAX_AREA_LENGTH = 120;
const VALID_KINDS: ReadonlyArray<ClinicalNoteKind> = [
  "consultation",
  "skin_hair_analysis",
];

// Unique-violation on the supersedes partial-unique index (a concurrent
// revision of the same note already won).
const UNIQUE_VIOLATION = "23505";

export type ClinicalNoteActionResult =
  | { ok: true; note: ClientClinicalNote }
  | { ok: false; code: "invalid" | "not_found" | "stale_revision" | "error"; error: string };

function readKind(value: FormDataEntryValue | null): ClinicalNoteKind | null {
  return typeof value === "string" && VALID_KINDS.includes(value as ClinicalNoteKind)
    ? (value as ClinicalNoteKind)
    : null;
}

function readBody(value: FormDataEntryValue | null): string {
  // Do NOT trim for storage: practitioners structure notes with leading
  // whitespace. Emptiness is judged on the trimmed length (mirrors the DB
  // check constraint length(btrim(body)) > 0).
  return typeof value === "string" ? value : "";
}

// Optional clinical event date. Empty → null (DB defaults to now()). A supplied
// value must parse as a date; an unparseable value is rejected rather than
// silently discarded (so a mistyped date never masquerades as "today").
function readOccurredAt(
  value: FormDataEntryValue | null,
): { ok: true; value: string | null } | { ok: false } {
  if (value == null || value === "") return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { ok: false };
  return { ok: true, value };
}

function readAreas(value: FormDataEntryValue | null): string[] | null {
  if (value == null || value === "") return [];
  if (typeof value !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const areas: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") return null;
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_AREA_LENGTH) return null;
    if (!areas.includes(trimmed)) areas.push(trimmed);
  }
  return areas.length > MAX_AREAS ? null : areas;
}

const SELECT_COLS =
  "id, client_id, studio_id, practitioner_id, kind, body, areas, occurred_at, supersedes_note_id, created_at";

// FIXED practitioner-facing copy. A clinical-note action NEVER returns a raw
// Postgres/PostgREST message.
//
// The failure mode this closes: these results are RETURNED as data, not thrown,
// so Next.js server-action error redaction does not apply to them, and
// ClinicalNotesSection renders `state.message` verbatim. An RLS denial or a
// constraint violation would therefore print table, policy and constraint names
// (and, in a constraint detail, row values) straight onto Chloe's screen.
const SAVE_FAILED_COPY =
  "We couldn't save this clinical note. Please try again.";
const VERIFY_FAILED_COPY =
  "Saved note could not be confirmed. Please reload and check before re-entering.";
const CLIENT_LOOKUP_FAILED_COPY =
  "We couldn't open this client's record. Please reload and try again.";

// Operator-side signal. Structured, non-PHI: the event, a safe SQLSTATE/code,
// the note KIND, and the ids we already own. Never the note body, never the
// areas (which can carry clinical detail), never the raw database message,
// a constraint detail can echo row values.
function logNoteFailure(
  event: string,
  detail: {
    code?: string;
    kind: ClinicalNoteKind;
    clientId: string;
    studioId: string;
    practitionerId: string;
    isRevision: boolean;
  },
): void {
  try {
    console.error(
      JSON.stringify({ event, ...detail, timestamp: new Date().toISOString() }),
    );
  } catch {
    console.error(event, detail.code ?? "unknown");
  }
}

// Shared insert + separate persisted-row verification. `supersedesNoteId` is
// null for a fresh note, or the id of the note being revised.
async function insertClinicalNote(params: {
  clientId: string;
  kind: ClinicalNoteKind;
  body: string;
  areas: string[];
  occurredAt: string | null;
  supersedesNoteId: string | null;
}): Promise<ClinicalNoteActionResult> {
  const { clientId, kind, body, areas, occurredAt, supersedesNoteId } = params;

  if (readBody(body).trim().length === 0) {
    return { ok: false, code: "invalid", error: "Note text is required." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return {
      ok: false,
      code: "invalid",
      error: `Note must be ${MAX_BODY_LENGTH} characters or fewer.`,
    };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Confirm the client is in this studio before writing (cleaner error than an
  // opaque RLS denial). RLS + the studio-derive trigger are the real guards.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) {
    logNoteFailure("clinical_note_client_lookup_failed", {
      code: clientErr.code,
      kind,
      clientId,
      studioId: studio.id,
      practitionerId: practitioner.id,
      isRevision: supersedesNoteId !== null,
    });
    return { ok: false, code: "error", error: CLIENT_LOOKUP_FAILED_COPY };
  }
  if (!client) return { ok: false, code: "not_found", error: "Client not found." };

  // studio_id passed for documentation; the BEFORE INSERT trigger overwrites it
  // from the parent client. practitioner_id is the signed-in practitioner.
  // occurred_at is the clinical event date (optional; DB defaults to now()).
  const insertRow: Record<string, unknown> = {
    client_id: clientId,
    studio_id: studio.id,
    practitioner_id: practitioner.id,
    kind,
    body,
    areas,
    supersedes_note_id: supersedesNoteId,
  };
  if (occurredAt) insertRow.occurred_at = occurredAt;

  const { data: inserted, error } = await supabase
    .from("client_clinical_notes")
    .insert(insertRow)
    .select("id")
    .single();

  if (error) {
    if (error.code === UNIQUE_VIOLATION && supersedesNoteId) {
      return {
        ok: false,
        code: "stale_revision",
        error:
          "This note was already revised elsewhere. Reload to see the latest version before revising again.",
      };
    }
    logNoteFailure("clinical_note_insert_failed", {
      code: error.code,
      kind,
      clientId,
      studioId: studio.id,
      practitionerId: practitioner.id,
      isRevision: supersedesNoteId !== null,
    });
    return { ok: false, code: "error", error: SAVE_FAILED_COPY };
  }
  if (!inserted?.id) {
    return { ok: false, code: "error", error: "Save did not return a stored note." };
  }

  // SEPARATE read-back: prove the row is actually persisted + readable under
  // this practitioner's RLS scope, with the body/kind/client we sent, before
  // reporting success. Never show "saved" on an unverified write.
  const { data: verified, error: verifyErr } = await supabase
    .from("client_clinical_notes")
    .select(SELECT_COLS)
    .eq("id", inserted.id)
    .maybeSingle();
  if (verifyErr) {
    logNoteFailure("clinical_note_readback_failed", {
      code: verifyErr.code,
      kind,
      clientId,
      studioId: studio.id,
      practitionerId: practitioner.id,
      isRevision: supersedesNoteId !== null,
    });
    return { ok: false, code: "error", error: VERIFY_FAILED_COPY };
  }
  const row = verified as ClientClinicalNote | null;
  if (
    !row ||
    row.client_id !== clientId ||
    row.kind !== kind ||
    row.body !== body ||
    (supersedesNoteId !== null && row.supersedes_note_id !== supersedesNoteId)
  ) {
    return {
      ok: false,
      code: "error",
      error: VERIFY_FAILED_COPY,
    };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true, note: row };
}

export async function addClinicalNoteAction(
  formData: FormData,
): Promise<ClinicalNoteActionResult> {
  const clientIdRaw = formData.get("client_id");
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (!clientId) return { ok: false, code: "invalid", error: "Missing client id." };

  const kind = readKind(formData.get("kind"));
  if (!kind) return { ok: false, code: "invalid", error: "Unknown note type." };

  const areas = readAreas(formData.get("areas"));
  if (areas === null) {
    return { ok: false, code: "invalid", error: "Invalid treatment-area tags." };
  }

  const occurredAt = readOccurredAt(formData.get("occurred_at"));
  if (!occurredAt.ok) {
    return { ok: false, code: "invalid", error: "Invalid note date." };
  }

  return insertClinicalNote({
    clientId,
    kind,
    body: readBody(formData.get("body")),
    areas: kind === "skin_hair_analysis" ? areas : [],
    occurredAt: occurredAt.value,
    supersedesNoteId: null,
  });
}

export async function reviseClinicalNoteAction(
  formData: FormData,
): Promise<ClinicalNoteActionResult> {
  const clientIdRaw = formData.get("client_id");
  const clientId = typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (!clientId) return { ok: false, code: "invalid", error: "Missing client id." };

  const kind = readKind(formData.get("kind"));
  if (!kind) return { ok: false, code: "invalid", error: "Unknown note type." };

  const supersedesRaw = formData.get("supersedes_note_id");
  const supersedesNoteId =
    typeof supersedesRaw === "string" ? supersedesRaw.trim() : "";
  if (!supersedesNoteId) {
    return { ok: false, code: "invalid", error: "Missing the note being revised." };
  }

  const areas = readAreas(formData.get("areas"));
  if (areas === null) {
    return { ok: false, code: "invalid", error: "Invalid treatment-area tags." };
  }

  const occurredAt = readOccurredAt(formData.get("occurred_at"));
  if (!occurredAt.ok) {
    return { ok: false, code: "invalid", error: "Invalid note date." };
  }

  return insertClinicalNote({
    clientId,
    kind,
    body: readBody(formData.get("body")),
    areas: kind === "skin_hair_analysis" ? areas : [],
    occurredAt: occurredAt.value,
    supersedesNoteId,
  });
}
