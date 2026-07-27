"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  assertSessionForClient,
  SessionLineageError,
} from "@/lib/sessions/session-lineage";
import type { CopySourceBlock } from "@/lib/sessions/whole-session-copy";
import {
  normalizeWholeSessionCopy,
  type WholeSessionCopyDraftInput,
} from "@/lib/sessions/whole-session-copy-normalize";

// Whole-session "Copy areas and settings" (migration 0157).
//
// getWholeSessionCopySourceAction: READ-ONLY. Asks the DB for the SERVER-derived
// canonical previous session (whole_session_copy_source_descriptor) + its
// fingerprint, then loads that source's blocks so the client can render an
// EPHEMERAL preview. The browser never chooses which session is the source.
//
// commitWholeSessionCopyAction: the single explicit write. It (1) re-checks
// auth + session lineage, (2) canonically NORMALIZES the reviewed draft
// server-side (rejecting any forged area/laterality/mode/probe/numeric), then
// (3) calls the service-role-only copy_session_setup RPC, passing a
// server-derived practitioner id and the preview's source fingerprint. The RPC
// is the single writer and independently enforces every source/target invariant.
// RPC errors are mapped to fixed, non-leaky messages.

const GENERIC_ERROR = "Couldn't copy right now. Please try again.";
const LINEAGE_ERROR = "That session couldn't be found.";

export type WholeSessionCopySourceResult =
  | {
      ok: true;
      eligible: boolean;
      source: CopySourceBlock[];
      sourceSessionId: string | null;
      sourceFingerprint: string | null;
      sourceStartedAt: string | null;
    }
  | { ok: false; error: string };

export async function getWholeSessionCopySourceAction(input: {
  clientId: string;
  sessionId: string;
}): Promise<WholeSessionCopySourceResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot copy sessions." };
  }
  try {
    // The destination (today) session must belong to this client + studio.
    await assertSessionForClient(studio.id, input.clientId, input.sessionId);
  } catch (e) {
    if (e instanceof SessionLineageError) return { ok: false, error: LINEAGE_ERROR };
    throw e;
  }

  const supabase = await createClient();

  // SERVER-authoritative source: the DB derives the canonical eligible previous
  // session and returns its fingerprint. The browser gets neither choice nor
  // authority over which session is copied.
  const { data: descriptor, error: descErr } = await supabase.rpc(
    "whole_session_copy_source_descriptor",
    { p_studio_id: studio.id, p_target_session_id: input.sessionId },
  );
  if (descErr) return { ok: false, error: GENERIC_ERROR };

  const desc = (descriptor ?? {}) as {
    eligible?: boolean;
    source_session_id?: string;
    source_fingerprint?: string;
    source_started_at?: string;
  };
  if (!desc.eligible || !desc.source_session_id) {
    return {
      ok: true,
      eligible: false,
      source: [],
      sourceSessionId: null,
      sourceFingerprint: null,
      sourceStartedAt: null,
    };
  }
  const sourceSessionId = desc.source_session_id;

  const { data: blocks, error: blockErr } = await supabase
    .from("session_blocks")
    .select(
      "id, sort_order, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_key, probe_brand, probe_material, probe_piece_type, probe_shank, probe_size_value, probe_length, probe_label, primary_area, side, custom_area_detail",
    )
    .eq("studio_id", studio.id)
    .eq("session_id", sourceSessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (blockErr) return { ok: false, error: GENERIC_ERROR };
  if (!blocks || blocks.length === 0) {
    return {
      ok: true,
      eligible: false,
      source: [],
      sourceSessionId: null,
      sourceFingerprint: null,
      sourceStartedAt: null,
    };
  }

  const blockIds = blocks.map((b) => b.id as string);
  const [{ data: areas }, { data: entries }] = await Promise.all([
    supabase
      .from("session_block_areas")
      .select("session_block_id, area, laterality, display_order")
      .in("session_block_id", blockIds)
      .order("display_order", { ascending: true }),
    supabase
      .from("electrolysis_entries")
      // galvanic_intensity_percent is a RETIRED reading (Phase A): not read for
      // the copy, so it is not part of the reusable-setup source projection.
      .select(
        "block_id, created_at, deleted_at, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count, pulse_delay_seconds",
      )
      .in("block_id", blockIds)
      .is("deleted_at", null)
      // Match the SQL fingerprint's earliest-entry tiebreak (created_at, id) so a
      // preview never seeds from a different entry than the fingerprint captured.
      .order("created_at", { ascending: true })
      .order("id", { ascending: true }),
  ]);

  const areasByBlock = new Map<string, { area: string; laterality: string }[]>();
  for (const a of areas ?? []) {
    const id = a.session_block_id as string;
    if (!areasByBlock.has(id)) areasByBlock.set(id, []);
    areasByBlock
      .get(id)!
      .push({ area: a.area as string, laterality: a.laterality as string });
  }
  const firstEntryByBlock = new Map<string, NonNullable<typeof entries>[number]>();
  for (const e of entries ?? []) {
    const id = e.block_id as string;
    if (!firstEntryByBlock.has(id)) firstEntryByBlock.set(id, e); // earliest wins
  }

  const source: CopySourceBlock[] = blocks.map((b) => {
    const fe = firstEntryByBlock.get(b.id as string) ?? null;
    return {
      blockId: b.id as string,
      primary_area: (b.primary_area as string | null) ?? null,
      side: (b.side as string | null) ?? null,
      custom_area_detail: (b.custom_area_detail as string | null) ?? null,
      block: {
        mode: (b.mode as string | null) ?? null,
        apilus_modality: (b.apilus_modality as string | null) ?? null,
        energy_level: (b.energy_level as number | null) ?? null,
        minutes_performed: (b.minutes_performed as number | null) ?? null,
        machine_frequency: (b.machine_frequency as string | null) ?? null,
        probe_key: (b.probe_key as string | null) ?? null,
      },
      probe: {
        probe_brand: (b.probe_brand as string | null) ?? null,
        probe_material: (b.probe_material as string | null) ?? null,
        probe_piece_type: (b.probe_piece_type as string | null) ?? null,
        probe_shank: (b.probe_shank as string | null) ?? null,
        probe_size_value: (b.probe_size_value as number | null) ?? null,
        probe_length: (b.probe_length as string | null) ?? null,
        probe_label: (b.probe_label as string | null) ?? null,
      },
      firstEntry: fe
        ? {
            created_at: fe.created_at as string,
            deleted_at: (fe.deleted_at as string | null) ?? null,
            mode: (fe.mode as string | null) ?? null,
            thermolysis_intensity_percent:
              (fe.thermolysis_intensity_percent as number | null) ?? null,
            thermolysis_duration_seconds:
              (fe.thermolysis_duration_seconds as number | null) ?? null,
            galvanic_ma: (fe.galvanic_ma as number | null) ?? null,
            galvanic_duration_seconds:
              (fe.galvanic_duration_seconds as number | null) ?? null,
            // galvanic_intensity_percent retired — not part of the copy source.
            units_of_lye: (fe.units_of_lye as number | null) ?? null,
            pulse_count: (fe.pulse_count as number | null) ?? null,
            pulse_delay_seconds: (fe.pulse_delay_seconds as number | null) ?? null,
          }
        : null,
      areas: areasByBlock.get(b.id as string) ?? [],
    };
  });

  // Consistency: the source rows above were read in separate queries after the
  // descriptor. Re-request the descriptor and confirm the source id + fingerprint
  // are unchanged, so the preview never returns rows from a different revision
  // than the fingerprint the practitioner will commit against.
  const { data: descriptor2, error: descErr2 } = await supabase.rpc(
    "whole_session_copy_source_descriptor",
    { p_studio_id: studio.id, p_target_session_id: input.sessionId },
  );
  if (descErr2) return { ok: false, error: GENERIC_ERROR };
  const desc2 = (descriptor2 ?? {}) as {
    eligible?: boolean;
    source_session_id?: string;
    source_fingerprint?: string;
  };
  if (
    !desc2.eligible ||
    desc2.source_session_id !== sourceSessionId ||
    desc2.source_fingerprint !== desc.source_fingerprint
  ) {
    return { ok: false, error: "The previous visit is being updated. Please try again." };
  }

  return {
    ok: true,
    eligible: true,
    source,
    sourceSessionId,
    sourceFingerprint: desc.source_fingerprint ?? null,
    sourceStartedAt: desc.source_started_at ?? null,
  };
}

export type WholeSessionCopyCommitResult =
  | { ok: true; createdBlockIds: string[]; copiedBlockCount: number; idempotentReplay: boolean }
  | { ok: false; error: string };

// Map the RPC's stable custom SQLSTATEs (class 'HN') to fixed, non-leaky
// messages. Any other code (or a driver error) becomes a generic message. Raw
// Postgres/Supabase text, SQLSTATE, UUIDs and constraint names never leak.
function safeCommitError(code: string | undefined): string {
  switch (code) {
    case "HN001":
      return "You don't have permission to do that.";
    case "HN002":
      return "This chart can't be prefilled — it isn't an editable electrolysis session.";
    case "HN003":
      return "Today's chart is no longer empty. Reload the page and try again.";
    case "HN004":
      return "There's no previous session to copy from.";
    case "HN005":
      return "The previous visit changed. Reload the preview and try again.";
    case "HN006":
      return "This copy couldn't be repeated safely. Reload the preview and try again.";
    case "HN007":
      return "A copied area or setting is invalid. Reload the preview and try again.";
    default:
      return GENERIC_ERROR;
  }
}

export async function commitWholeSessionCopyAction(input: {
  clientId: string;
  sessionId: string;
  drafts: WholeSessionCopyDraftInput[];
  idempotencyKey: string;
  sourceSessionId: string | null;
  sourceFingerprint: string | null;
}): Promise<WholeSessionCopyCommitResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot log sessions." };
  }
  try {
    await assertSessionForClient(studio.id, input.clientId, input.sessionId);
  } catch (e) {
    if (e instanceof SessionLineageError) return { ok: false, error: LINEAGE_ERROR };
    throw e;
  }

  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    return { ok: false, error: "Reload the preview and try again." };
  }
  // Source identity + fingerprint are REQUIRED — reject before any write.
  if (!input.sourceSessionId || !input.sourceFingerprint) {
    return { ok: false, error: "Reload the preview and try again." };
  }

  // Canonical server-side validation of the browser draft BEFORE any DB write.
  const normalized = normalizeWholeSessionCopy(input.drafts);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  // The RPC is the single writer, callable ONLY by service_role. We pass a
  // server-derived practitioner id + the preview's source fingerprint; the RPC
  // re-derives the canonical source, re-checks target eligibility/emptiness
  // under a row lock, verifies the fingerprint, and is atomic + idempotent.
  const admin = createAdminClient(); // scope: server-derived studio + getCurrentPractitionerWithStudio
  const { data, error } = await admin.rpc("copy_session_setup", {
    p_studio_id: studio.id,
    p_target_session_id: input.sessionId,
    p_practitioner_id: practitioner.id,
    p_specs: normalized.specs,
    p_idempotency_key: input.idempotencyKey,
    p_expected_source_fingerprint: input.sourceFingerprint,
    p_expected_source_session_id: input.sourceSessionId,
  });
  if (error) {
    return { ok: false, error: safeCommitError((error as { code?: string }).code) };
  }

  const result = (data ?? {}) as {
    created_block_ids?: string[];
    copied_block_count?: number;
    idempotent_replay?: boolean;
  };
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return {
    ok: true,
    createdBlockIds: result.created_block_ids ?? [],
    copiedBlockCount: result.copied_block_count ?? 0,
    idempotentReplay: Boolean(result.idempotent_replay),
  };
}
