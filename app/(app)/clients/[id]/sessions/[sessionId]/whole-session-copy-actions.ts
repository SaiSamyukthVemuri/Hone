"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { assertSessionForClient } from "@/lib/sessions/session-lineage";
import type {
  CopySourceBlock,
  WholeSessionCopySpec,
} from "@/lib/sessions/whole-session-copy";

// Whole-session "Copy areas and settings" (migration 0157).
//
// getWholeSessionCopySourceAction: READ-ONLY. Loads the previous session's
// blocks (+ structured areas + first-entry setup readings) so the client can
// render an EPHEMERAL preview. It writes nothing.
//
// commitWholeSessionCopyAction: the single explicit write. Calls the atomic,
// idempotent copy_session_setup RPC once; every safety property (setup-only,
// same-studio, all-or-nothing, at-most-once) is enforced in the RPC.

export type WholeSessionCopySourceResult =
  | { ok: true; source: CopySourceBlock[] }
  | { ok: false; error: string };

export async function getWholeSessionCopySourceAction(input: {
  clientId: string;
  sessionId: string;
  previousSessionId: string;
}): Promise<WholeSessionCopySourceResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot copy sessions." };
  }
  // Both the destination (today) and the source (previous) session must belong
  // to this client + studio — RLS + these lineage checks together.
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);
  await assertSessionForClient(studio.id, input.clientId, input.previousSessionId);

  const supabase = await createClient();
  const { data: blocks, error: blockErr } = await supabase
    .from("session_blocks")
    .select(
      "id, sort_order, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_key, probe_brand, probe_material, probe_piece_type, probe_shank, probe_size_value, probe_length, probe_label, primary_area, side, custom_area_detail",
    )
    .eq("studio_id", studio.id)
    .eq("session_id", input.previousSessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (blockErr) return { ok: false, error: blockErr.message };
  if (!blocks || blocks.length === 0) return { ok: true, source: [] };

  const blockIds = blocks.map((b) => b.id as string);
  const [{ data: areas }, { data: entries }] = await Promise.all([
    supabase
      .from("session_block_areas")
      .select("session_block_id, area, laterality, display_order")
      .in("session_block_id", blockIds)
      .order("display_order", { ascending: true }),
    supabase
      .from("electrolysis_entries")
      .select(
        "block_id, created_at, deleted_at, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, thermolysis_intensity_percent, thermolysis_duration_seconds, galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent, units_of_lye, pulse_count, pulse_delay_seconds",
      )
      .in("block_id", blockIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
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
            galvanic_intensity_percent:
              (fe.galvanic_intensity_percent as number | null) ?? null,
            units_of_lye: (fe.units_of_lye as number | null) ?? null,
            pulse_count: (fe.pulse_count as number | null) ?? null,
            pulse_delay_seconds: (fe.pulse_delay_seconds as number | null) ?? null,
          }
        : null,
      areas: areasByBlock.get(b.id as string) ?? [],
    };
  });
  return { ok: true, source };
}

export type WholeSessionCopyCommitResult =
  | { ok: true; createdBlockIds: string[]; idempotentReplay: boolean }
  | { ok: false; error: string };

export async function commitWholeSessionCopyAction(input: {
  clientId: string;
  sessionId: string;
  specs: WholeSessionCopySpec[];
  idempotencyKey: string;
}): Promise<WholeSessionCopyCommitResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot log sessions." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  if (!input.specs || input.specs.length === 0) {
    return { ok: false, error: "Nothing to copy." };
  }
  if (!input.idempotencyKey || input.idempotencyKey.trim() === "") {
    return { ok: false, error: "Missing copy key." };
  }

  const supabase = await createClient();
  // The RPC is the ONLY writer: atomic (all N blocks+areas+entries in one txn),
  // idempotent (at-most-once per idempotency key), and setup-only by its own
  // INSERT allow-list. Studio scoping + lineage are re-checked inside it.
  const { data, error } = await supabase.rpc("copy_session_setup", {
    p_studio_id: studio.id,
    p_session_id: input.sessionId,
    p_specs: input.specs,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) return { ok: false, error: `Copy failed: ${error.message}` };

  const result = (data ?? {}) as {
    created_block_ids?: string[];
    idempotent_replay?: boolean;
  };
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return {
    ok: true,
    createdBlockIds: result.created_block_ids ?? [],
    idempotentReplay: Boolean(result.idempotent_replay),
  };
}
