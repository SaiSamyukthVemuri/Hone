"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { scopeAuditMetadata } from "@/lib/clinical-records/export-scope";
import { loadExportClientIdentity, recordClinicalRecordsAudit } from "@/lib/clinical-records/export-queries";
import { verifyPrintToken } from "@/lib/clinical-records/print-token";

// HON-46. Records the PRINT of a clinical-records export before the browser
// print dialog opens (#828 G-13: every download is audited, fail closed). The
// button calls this and prints only on ok:true, so a print the audit trail
// cannot see does not happen through this control.
//
// BOUND TO THE RENDERED PREVIEW (Codex P1 4303617257). The ONLY input is the
// token the server minted when it rendered the preview. The client and scope
// audited here come from that verified token, never from the request, so an
// altered payload cannot audit a different client or scope than the one on
// screen. The owner role, the studio, the actor, the token's age and the
// client's membership of the studio are all re-checked server-side.

export async function recordClinicalRecordsPrintAction(token: string): Promise<{ ok: boolean }> {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.active) return { ok: false };
  const check = verifyPrintToken(token, { studioId: studio.id, actorId: practitioner.id });
  if (!check.ok) return { ok: false };
  const { clientId, scope, previewAuditId } = check.claims;
  // Identity only (Codex P1 4301153305): never the broad profile loader.
  const client = await loadExportClientIdentity(studio.id, clientId);
  if (!client) return { ok: false };
  return recordClinicalRecordsAudit({
    studioId: studio.id,
    actorId: practitioner.id,
    clientId: client.id,
    action: "clinical_records_printed",
    metadata: { ...scopeAuditMetadata(scope), preview_audit_id: previewAuditId },
  });
}
