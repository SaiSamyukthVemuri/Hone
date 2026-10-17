"use server";

import { requirePractitionerWithStudio, getClientById } from "@/lib/supabase/queries";
import { parseExportScope, scopeAuditMetadata } from "@/lib/clinical-records/export-scope";
import { recordClinicalRecordsAudit } from "@/lib/clinical-records/export-queries";

// HON-46. Records the PRINT of a clinical-records export before the browser
// print dialog opens (#828 G-13: every download is audited, fail closed). The
// button calls this and prints only on ok:true, so a print the audit trail
// cannot see does not happen through this control.
//
// Re-derives everything server-side: owner role, the client belongs to the
// studio, and the scope parses. Nothing the browser sends is trusted.

export async function recordClinicalRecordsPrintAction(
  clientId: string,
  rawScope: { scope?: string; session?: string; day?: string; from?: string; to?: string },
): Promise<{ ok: boolean }> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) return { ok: false };
  const parsed = parseExportScope(rawScope);
  if (!parsed.ok) return { ok: false };
  const client = await getClientById(studio.id, clientId);
  if (!client) return { ok: false };
  return recordClinicalRecordsAudit({
    studioId: studio.id,
    actorId: practitioner.id,
    clientId,
    action: "clinical_records_printed",
    metadata: scopeAuditMetadata(parsed.scope),
  });
}
