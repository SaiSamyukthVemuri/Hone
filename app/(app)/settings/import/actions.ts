"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  buildImportPlan,
  clientIdentityKey,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  parseImportText,
  toClientInsertFields,
  toMemoryInsertFields,
  validSourceType,
  type ExistingClient,
  type PlannedGroup,
} from "@/lib/import/quick-import";
import {
  isImportOperator,
  IMPORT_OPERATOR_ASSISTED_DENIAL,
} from "@/lib/import/operator-assist";
import type { ImportSourceType } from "@/lib/types/database";

// IMPORT-01 (mitigation): execution is OPERATOR-ASSISTED ONLY. An ordinary
// studio owner is refused in ownerContext() below, before any statement runs,
// because a part-finished import leaves client rows behind that a retry then
// skips. The pipeline itself is untouched and stays here so the eventual
// staged/transactional/resumable rebuild can be built from it. See
// lib/import/operator-assist.ts for the full reasoning.
//
// PR #257: Quick Import V1 server actions. Owner-only. Reads/writes go through
// the RLS-backed authenticated client (createClient), NO service role: the
// 0089 owner-INSERT policies + the 0087 clients member-INSERT policy let the
// owner insert directly, and RLS keeps everything studio-scoped. The raw
// pasted text is parsed transiently and is NEVER stored or logged. The import
// writes ONLY import_batches + clients + imported_treatment_memories, never
// sessions, session_blocks, appointments, payments, reminders, or messages.

// --- serializable preview/confirm shapes (no raw rows leave the server) ------

export type PreviewGroup = {
  fullName: string;
  action: "create" | "skip_duplicate" | "warning";
  duplicateReason: string | null;
  treatmentAreas: string[];
  memoryRowCount: number;
  warnings: string[];
};

export type PreviewSummary = {
  totalSourceRows: number;
  groupedClients: number;
  readyGroups: number;
  warningGroups: number;
  duplicateGroups: number;
  errorRows: number;
  memoriesToCreate: number;
  detectedFields: string[];
  ignoredColumns: string[];
  treatmentAreas: string[];
  capped: boolean;
  totalDataRows: number;
  groups: PreviewGroup[];
};

export type PreviewResult =
  | { ok: true; preview: PreviewSummary }
  | { ok: false; error: string };

export type ConfirmSummary = {
  batchId: string;
  clientsCreated: number;
  memoriesCreated: number;
  duplicatesSkipped: number;
  groupedClients: number;
  warningGroups: number;
  rowsNotImported: number;
  createdClients: { id: string; name: string }[];
};

export type ConfirmResult =
  | { ok: true; summary: ConfirmSummary }
  | { ok: false; error: string };

type OwnerContext = {
  studioId: string;
  practitionerId: string;
  userId: string;
};

// Owner gate + IMPORT-01 operator gate. getCurrentPractitionerWithStudio() is
// the throwing variant; the (app) shell already guarantees an authenticated
// practitioner+studio, so any throw here is a genuine error. Returns an error
// (never a context) for non-owners AND for owners without operator standing.
//
// BOTH server actions route through here, and it runs before the first
// statement of either, so a direct POST to the action, bypassing the page
// entirely, is refused on exactly the same terms as a click.
async function ownerContext(): Promise<
  { ctx: OwnerContext } | { error: string }
> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active || practitioner.role !== "owner") {
    return { error: "Only studio owners can import." };
  }
  // Operator standing is checked on the AUTH user, not on the practitioner
  // row, and is required in addition to ownership, never instead of it.
  if (!(await isImportOperator())) {
    return { error: IMPORT_OPERATOR_ASSISTED_DENIAL };
  }
  return {
    ctx: {
      studioId: studio.id,
      practitionerId: practitioner.id,
      userId: practitioner.user_id ?? "",
    },
  };
}

async function loadExistingClients(
  studioId: string,
): Promise<ExistingClient[]> {
  const supabase = await createClient();
  // Studio-scoped via RLS; include archived rows so a confident email/name+DOB
  // match against an archived client is still SKIPPED (and the per-studio
  // unique email index is respected).
  const { data, error } = await supabase
    .from("clients")
    .select("id, name, email, phone, date_of_birth")
    .eq("studio_id", studioId);
  if (error) throw new Error("Could not load existing clients for the import.");
  return (data ?? []) as ExistingClient[];
}

function toPreview(plan: ReturnType<typeof buildImportPlan>): PreviewSummary {
  return {
    totalSourceRows: plan.totalSourceRows,
    groupedClients: plan.groupedClients,
    readyGroups: plan.readyGroups,
    warningGroups: plan.warningGroups,
    duplicateGroups: plan.duplicateGroups,
    errorRows: plan.errorRows,
    memoriesToCreate: plan.memoriesToCreate,
    detectedFields: plan.detectedFields,
    ignoredColumns: plan.ignoredColumns,
    treatmentAreas: plan.treatmentAreas,
    capped: plan.capped,
    totalDataRows: plan.totalDataRows,
    groups: plan.groups.map((g) => ({
      fullName: g.fullName,
      action: g.action,
      duplicateReason: g.duplicateOf?.reason ?? null,
      treatmentAreas: g.treatmentAreas,
      memoryRowCount: g.memoryRowCount,
      warnings: g.warnings,
    })),
  };
}

export async function previewImportAction(text: string): Promise<PreviewResult> {
  const gate = await ownerContext();
  if ("error" in gate) return { ok: false, error: gate.error };

  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "Paste CSV or TSV rows first." };
  }
  const parsed = parseImportText(text);
  if (parsed.rows.length === 0) {
    return { ok: false, error: "No data rows found below the header." };
  }
  const existing = await loadExistingClients(gate.ctx.studioId);
  const plan = buildImportPlan(parsed, existing);
  return { ok: true, preview: toPreview(plan) };
}

// Match a bulk-inserted client row back to its import group. Uses the SAME
// clientIdentityKey as grouping (single source of truth. They cannot diverge),
// and groups are distinct by this key, so the match is unambiguous.
function clientSignature(c: {
  email: string | null;
  phone: string | null;
  name: string;
  date_of_birth: string | null;
}): string {
  return clientIdentityKey({
    email: normalizeEmail(c.email),
    phone: normalizePhone(c.phone),
    name: normalizeName(c.name),
    dateOfBirth: c.date_of_birth,
  });
}

export async function confirmImportAction(
  text: string,
  sourceTypeRaw: string,
): Promise<ConfirmResult> {
  const gate = await ownerContext();
  if ("error" in gate) return { ok: false, error: gate.error };
  const { ctx } = gate;
  const sourceType: ImportSourceType = validSourceType(sourceTypeRaw);

  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, error: "Paste CSV or TSV rows first." };
  }

  const supabase = await createClient();
  const parsed = parseImportText(text);
  if (parsed.rows.length === 0) {
    return { ok: false, error: "No data rows found below the header." };
  }
  const existing = await loadExistingClients(ctx.studioId);
  const plan = buildImportPlan(parsed, existing);

  // Create everything that is NOT a confident duplicate (warnings included).
  const toCreate = plan.groups.filter((g) => g.action !== "skip_duplicate");
  const duplicatesSkipped = plan.duplicateGroups;

  if (toCreate.length === 0) {
    return {
      ok: false,
      error:
        duplicatesSkipped > 0
          ? "Every row matched an existing client, so nothing was imported."
          : "There were no importable rows.",
    };
  }

  // 1) The import batch (the unit of correction/void). row_count is the source
  //    rows pasted; completed_at is set ONLY after the import succeeds, so a
  //    voided/incomplete batch is never marked completed. On a later failure we
  //    soft-void this batch (no hard delete, 0089/0087 posture).
  const { data: batch, error: batchErr } = await supabase
    .from("import_batches")
    .insert({
      studio_id: ctx.studioId,
      source_type: sourceType,
      source_label: "CSV/TSV import",
      row_count: parsed.rows.length,
      created_by: ctx.userId || null,
    })
    .select("id")
    .single();
  if (batchErr || !batch) {
    return { ok: false, error: "Could not start the import. Please try again." };
  }
  const batchId = batch.id as string;

  // Returns true if the void itself succeeded, so the caller can be honest if
  // even the rollback failed.
  const softVoidBatch = async (reason: string): Promise<boolean> => {
    const { error } = await supabase
      .from("import_batches")
      .update({
        voided_at: new Date().toISOString(),
        voided_by: ctx.userId || null,
        void_reason: reason,
      })
      .eq("id", batchId);
    return !error;
  };

  // 2) Bulk-create the new clients (one statement = atomic). Map returned ids
  //    back to groups by identity signature.
  const clientInserts = toCreate.map((g) => ({
    ...toClientInsertFields(g.group),
    studio_id: ctx.studioId,
    created_by: ctx.practitionerId,
  }));
  const { data: createdClients, error: clientErr } = await supabase
    .from("clients")
    .insert(clientInserts)
    .select("id, name, email, phone, date_of_birth");
  if (clientErr || !createdClients) {
    await softVoidBatch("Client creation failed during import.");
    // Generic messages only, never interpolate raw DB errors (could carry a
    // pasted email/phone in some drivers).
    const isDuplicate = clientErr?.code === "23505";
    return {
      ok: false,
      error: isDuplicate
        ? "An email in your paste already matches an existing client. Remove duplicate emails and try again, nothing was imported."
        : "No clients were imported because of a database error. Nothing was imported.",
    };
  }

  const idBySignature = new Map<string, string>();
  for (const c of createdClients as ExistingClient[]) {
    idBySignature.set(clientSignature(c), c.id);
  }

  // 3) Bulk-create the imported treatment-memory rows (one statement = atomic).
  const memoryInserts: Record<string, unknown>[] = [];
  for (const g of toCreate as PlannedGroup[]) {
    const clientId = idBySignature.get(g.group.key);
    if (!clientId) continue; // defensive: should always match
    for (const row of g.group.rows) {
      const mem = toMemoryInsertFields(row, sourceType);
      if (!mem) continue;
      memoryInserts.push({
        ...mem,
        studio_id: ctx.studioId,
        client_id: clientId,
        import_batch_id: batchId,
        imported_by: ctx.userId || null,
      });
    }
  }

  if (memoryInserts.length > 0) {
    // The memory insert is a single atomic statement (all-or-none) with valid,
    // owner-scoped rows, so a failure here is essentially transient: retry
    // once before giving up.
    let memErr = (
      await supabase.from("imported_treatment_memories").insert(memoryInserts)
    ).error;
    if (memErr) {
      memErr = (
        await supabase.from("imported_treatment_memories").insert(memoryInserts)
      ).error;
    }
    if (memErr) {
      // Clients were created (0087 forbids hard-deleting them); void the batch
      // so its zero memory rows are excluded, and report HONESTLY: re-importing
      // will skip these now-existing clients (Quick Import does not modify
      // existing clients: attach-to-existing is a future PR).
      const voided = await softVoidBatch(
        "Imported memory creation failed during import.",
      );
      return {
        ok: false,
        error: `${createdClients.length} client(s) were created, but their imported treatment history could not be saved${voided ? " (the import was voided)" : ""}. Re-importing will skip these clients, so their history must be added separately: please contact support if this persists.`,
      };
    }
  }

  // Mark the batch completed only now that everything succeeded.
  await supabase
    .from("import_batches")
    .update({ completed_at: new Date().toISOString() })
    .eq("id", batchId);

  revalidatePath("/clients");

  return {
    ok: true,
    summary: {
      batchId,
      clientsCreated: createdClients.length,
      memoriesCreated: memoryInserts.length,
      duplicatesSkipped,
      groupedClients: plan.groupedClients,
      warningGroups: plan.warningGroups,
      rowsNotImported: plan.errorRows,
      createdClients: (createdClients as { id: string; name: string }[])
        .slice(0, 100)
        .map((c) => ({ id: c.id, name: c.name })),
    },
  };
}
