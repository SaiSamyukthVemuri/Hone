// HON-46 M2 — the audit contract of the day packet, and the ordering rule.
//
// Migration 0233 (record_clinical_records_audit) is the ONLY way these events
// are written: the database derives the studio from the client and the actor
// from auth.uid() as the studio's active OWNER, allow-lists the action and the
// metadata keys, and raises 22023 on any other shape. So the shapes below are
// exactly what 0233 accepts for scope "day", and nothing else:
//   preview: { scope: "day", day }
//   print:   { scope: "day", day, preview_audit_id }
//
// A PRINT cites its preview's audit id; 0233 enforces in the database that the
// cited row is the caller's own preview of the SAME client and scope created in
// the last 30 minutes. There is deliberately no client-side token (OPS ruling
// 7 Nov): a forged preview_audit_id can only point at the caller's own preview.

export type DayAuditAction = "clinical_records_previewed" | "clinical_records_printed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function previewAuditMetadata(day: string): Record<string, string> {
  return { scope: "day", day };
}

export function printAuditMetadata(day: string, previewAuditId: string): Record<string, string> {
  return { scope: "day", day, preview_audit_id: previewAuditId };
}

type RpcResult = PromiseLike<{ data: unknown; error: unknown }>;
/** `supabase.rpc` bound to a signed-in (user-scoped) client; never service_role. */
export type AuditRpc = (fn: "record_clinical_records_audit", args: Record<string, unknown>) => RpcResult;

/**
 * Write one audit row. Returns the new row's id, or null on ANY failure so the
 * caller can refuse (fail closed). Nothing from an error is returned or logged:
 * a database or transport error can quote row data.
 */
export async function recordDayAudit(
  rpc: AuditRpc,
  args: { clientId: string; action: DayAuditAction; metadata: Record<string, string> },
): Promise<{ ok: true; auditId: string } | { ok: false }> {
  try {
    const { data, error } = await rpc("record_clinical_records_audit", {
      p_client_id: args.clientId,
      p_action: args.action,
      p_metadata: args.metadata,
      p_id: null,
    });
    // 0233 returns the inserted row's uuid. An error-free but malformed response
    // is not evidence that the event was recorded.
    if (error || typeof data !== "string" || !UUID.test(data)) return { ok: false };
    return { ok: true, auditId: data.toLowerCase() };
  } catch {
    return { ok: false };
  }
}

export type PreviewOutcome<T> =
  | { ok: true; document: T; previewAuditId: string }
  | { ok: false; reason: "audit_failed" | "load_failed" };

/**
 * Record the preview FIRST and load nothing unless it was recorded (#828 G-13:
 * every preview is audited, fail closed). Pure orchestration, so the ordering is
 * unit-tested without a database.
 */
export async function auditThenLoad<T>(
  audit: () => Promise<{ ok: true; auditId: string } | { ok: false }>,
  load: () => Promise<{ ok: true; value: T } | { ok: false }>,
): Promise<PreviewOutcome<T>> {
  const recorded = await audit().catch(() => ({ ok: false as const }));
  if (!recorded.ok) return { ok: false, reason: "audit_failed" };
  const loaded = await load().catch(() => ({ ok: false as const }));
  if (!loaded.ok) return { ok: false, reason: "load_failed" };
  return { ok: true, document: loaded.value, previewAuditId: recorded.auditId };
}

/**
 * The owner gate, as one predicate used by the page AND the print action.
 * 0233 enforces the same rule in the database; this is the application half.
 */
export function canPrintClinicalPacket(practitioner: { role: string; active: boolean }): boolean {
  return practitioner.role === "owner" && practitioner.active === true;
}
