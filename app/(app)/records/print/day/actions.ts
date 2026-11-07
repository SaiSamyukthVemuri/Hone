"use server";

import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { canPrintClinicalPacket, printAuditMetadata, recordDayAudit } from "@/lib/records/print/day-audit";
import { parseSelectedDay } from "@/lib/records/print/selected-day";

// HON-46. Records the PRINT of a day packet before the browser print dialog
// opens (#828 G-13, fail closed). The Print button prints only on ok:true.
//
// Stated precisely: a preview is audited before any record is read; this
// button's print is audited; the browser's own print (Ctrl/Cmd+P, Save as PDF)
// never runs this action, so the page GATES it (the document is hidden in print
// media unless this audited button armed it). It is never "every print is audited".
//
// The database binds the print: migration 0233 requires `preview_audit_id` to be
// THIS owner's own preview of THIS client and day, created within 30 minutes, and
// raises 22023 otherwise. So a forged id can only name the caller's own preview.
// Nothing here logs or returns the client id, the day or any error text.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordDayPacketPrintAction(input: {
  clientId: string;
  day: string;
  previewAuditId: string;
}): Promise<{ ok: boolean }> {
  const { practitioner } = await requirePractitionerWithStudio();
  if (!canPrintClinicalPacket(practitioner)) return { ok: false };
  if (typeof input?.clientId !== "string" || !UUID.test(input.clientId)) return { ok: false };
  if (typeof input.previewAuditId !== "string" || !UUID.test(input.previewAuditId)) return { ok: false };
  const day = parseSelectedDay(input.day);
  if (!day.ok) return { ok: false };
  const supabase = await createClient();
  const recorded = await recordDayAudit((fn, args) => supabase.rpc(fn, args), {
    clientId: input.clientId,
    action: "clinical_records_printed",
    metadata: printAuditMetadata(day.day, input.previewAuditId),
  });
  return { ok: recorded.ok };
}
