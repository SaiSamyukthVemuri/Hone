"use server";

// HON-130: server entry points for autosaved note drafts. Drafts are transient author-private text (migration 0399); these
// actions never write client_clinical_notes or client_budget_context. Studio and practitioner come from the SESSION inside the
// database command, never from the request. Results are CLOSED codes: no draft text is ever logged or put in an error.

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { safeLog } from "@/lib/logging/safe-log";
import {
  NOTE_DRAFT_KINDS,
  type NoteDraftFields,
  type NoteDraftKey,
  type NoteDraftKind,
  type NoteDraftSaveResult,
  type StoredNoteDraft,
} from "@/lib/note-drafts/types";
import { sanitizeDraftFields } from "@/lib/note-drafts/sanitize";
import { noteDraftsEnabledFor } from "@/lib/note-drafts/enabled";
import { draftScope } from "@/lib/note-drafts/scope";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validKey(key: NoteDraftKey): boolean {
  if (!UUID.test(key.clientId)) return false;
  if (!(NOTE_DRAFT_KINDS as readonly string[]).includes(key.kind)) return false;
  if (key.kind === "budget") return key.target === "current";
  return key.target === "new" || UUID.test(key.target);
}

type SaveRow = { status: string; revision: number; fields: unknown; updated_at: string | null; generation: string | null };

export async function saveNoteDraftAction(input: {
  key: NoteDraftKey;
  fields: NoteDraftFields;
  expectedRevision: number;
  writer: string;
  /** The practitioner:studio the sending saver was created under. */
  scope: string;
  /** The draft lifecycle this write belongs to (a client-minted uuid). */
  generation: string;
}): Promise<NoteDraftSaveResult> {
  if (!validKey(input.key) || !UUID.test(input.writer) || !UUID.test(input.generation) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { status: "invalid" };
  }
  const fields = sanitizeDraftFields(input.key.kind, input.fields);
  if (!fields) return { status: "invalid" };
  try {
    const { studio, practitioner } = await getCurrentPractitionerWithStudio();
    // Another user signed in (in another tab) since this saver was created: refuse, store nothing. Checked BEFORE the command is called.
    if (input.scope !== draftScope(practitioner.id, studio.id)) return { status: "refused" };
    // Server-side switch: OFF means nothing is stored, whatever the client sends.
    if (!noteDraftsEnabledFor(studio.id)) return { status: "disabled" };
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("save_client_note_draft", {
      p_studio_id: studio.id,
      p_client_id: input.key.clientId,
      p_kind: input.key.kind,
      p_target: input.key.target,
      p_fields: fields,
      p_expected_revision: input.expectedRevision,
      p_writer: input.writer,
      p_generation: input.generation,
    });
    if (error) {
      safeLog.error(JSON.stringify({ event: "note_draft_save_failed", timestamp: new Date().toISOString() }));
      return { status: "error" };
    }
    const row = (Array.isArray(data) ? data[0] : data) as SaveRow | undefined;
    if (!row) return { status: "error" };
    const savedAt = row.updated_at ?? new Date().toISOString();
    if (row.status === "ok") return { status: "ok", revision: row.revision, savedAt };
    if (row.status === "conflict") {
      const theirs = sanitizeDraftFields(input.key.kind, row.fields) ?? {};
      const theirGeneration = row.generation && UUID.test(row.generation) ? row.generation : input.generation;
      return { status: "conflict", revision: row.revision, fields: theirs, savedAt, generation: theirGeneration };
    }
    if (row.status === "cleared") return { status: "cleared", revision: Number.isInteger(row.revision) && row.revision > 0 ? row.revision : 0 };
    if (row.status === "gone" || row.status === "refused" || row.status === "disabled") return { status: row.status };
    return { status: "error" };
  } catch {
    safeLog.error(JSON.stringify({ event: "note_draft_save_threw", timestamp: new Date().toISOString() }));
    return { status: "error" };
  }
}

export async function discardNoteDraftAction(key: NoteDraftKey, scope: string, generation: string): Promise<{ ok: boolean }> {
  if (!validKey(key) || !UUID.test(generation)) return { ok: false };
  try {
    const { studio, practitioner } = await getCurrentPractitionerWithStudio();
    if (scope !== draftScope(practitioner.id, studio.id)) return { ok: false };
    // NOT behind the switch: an author can always delete their own draft, whether or not autosave is on for the studio.
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("discard_client_note_draft", {
      p_studio_id: studio.id,
      p_client_id: key.clientId,
      p_kind: key.kind,
      p_target: key.target,
      p_generation: generation,
    });
    // ok means the server CONFIRMED the draft is gone: false from the database (no live draft of that generation) is a failed discard, not a success.
    return { ok: !error && data === true };
  } catch {
    return { ok: false };
  }
}

/** The caller's own live draft of ONE key (author-only RLS), or none. `ok` false = the read failed, so the caller must not assume the key is free. */
export async function peekNoteDraftAction(key: NoteDraftKey, scope: string): Promise<{ ok: boolean; draft: StoredNoteDraft | null }> {
  if (!validKey(key)) return { ok: false, draft: null };
  try {
    const { studio, practitioner } = await getCurrentPractitionerWithStudio();
    if (scope !== draftScope(practitioner.id, studio.id)) return { ok: false, draft: null };
    if (!noteDraftsEnabledFor(studio.id)) return { ok: true, draft: null };
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("client_note_drafts")
      .select("kind, target, fields, revision, updated_at, generation")
      .eq("client_id", key.clientId)
      .eq("kind", key.kind)
      .eq("target", key.target)
      .maybeSingle();
    if (error) return { ok: false, draft: null };
    const r = data as { fields: unknown; revision: number; updated_at: string; generation: string | null } | null;
    if (!r || r.fields == null || !r.generation) return { ok: true, draft: null };
    const fields = sanitizeDraftFields(key.kind, r.fields);
    if (!fields) return { ok: true, draft: null };
    return { ok: true, draft: { key, fields, revision: r.revision, savedAt: r.updated_at, generation: r.generation } };
  } catch {
    return { ok: false, draft: null };
  }
}
