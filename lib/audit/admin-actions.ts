import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { redactOpsAlertDetails } from "@/lib/ops/redact";

// Admin/operator action audit log (migration 0113). This is the ONLY writer of
// admin_action_events and the ONLY reader for the /admin audit view. Both go
// through the service-role client (the table is RLS-locked to service-role;
// callers must have already passed the isAdmin gate). Production infrastructure,
// not a client feature.

export const ADMIN_ACTION_OUTCOMES = [
  "started",
  "succeeded",
  "failed",
  "blocked",
] as const;
export type AdminActionOutcome = (typeof ADMIN_ACTION_OUTCOMES)[number];

// Metadata KEY blocklist (substring, case-insensitive). Any key that looks
// credential- or PII-shaped is dropped entirely — a caller can never leak a
// token/secret/url/card/email/phone into the audit metadata even by accident.
const SENSITIVE_KEY_RE =
  /token|secret|password|passwd|\bkey\b|api[_-]?key|url|href|card|cvc|cvv|stripe_secret|authorization|cookie|bearer|jwt|magic|email|phone|ssn|dob|address|note_text|body|payload/i;

// Sanitize caller-supplied metadata into a safe, flat jsonb bag:
//   * drop sensitive-looking KEYS (blocklist above);
//   * keep only primitive values (number / boolean / short string);
//   * then run the shared ops-alert redactor over the result as a second,
//     value-level pass (scrubs Stripe secrets / JWT / signed URLs / emails /
//     phones / high-entropy tokens that slipped through as string values).
export function sanitizeAdminAuditMetadata(
  input: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (SENSITIVE_KEY_RE.test(k)) continue;
      if (v == null) continue;
      if (typeof v === "number" || typeof v === "boolean") out[k] = v;
      else if (typeof v === "string") out[k] = v.slice(0, 200);
      // objects / arrays are intentionally dropped: keep metadata flat + safe.
    }
  }
  return redactOpsAlertDetails(out);
}

export type LogAdminActionInput = {
  actorUserId?: string | null;
  actorEmail?: string | null;
  actorRole?: string | null;
  studioId?: string | null;
  targetType: string;
  targetId?: string | null;
  action: string;
  outcome: AdminActionOutcome;
  source?: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

// Record one admin action event. FAIL-SOFT: never throws, so an audit-log
// outage (or the table not existing pre-migration) can never break the admin
// action it is recording. Callers own the isAdmin gate; this helper only
// records. For the highest-risk write (studio creation) callers additionally
// log a 'started' event before the write so a trail exists even if the terminal
// event fails; audit-before-write BLOCKING is intentionally NOT enforced in PR 1
// (a legitimate operator action must not be blocked by an audit-infra hiccup —
// a miss is console-logged and can be alerted). See docs/security/admin-audit-log.md.
export async function logAdminAction(input: LogAdminActionInput): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("admin_action_events").insert({
      actor_user_id: input.actorUserId ?? null,
      actor_email: input.actorEmail ?? null,
      actor_role: input.actorRole ?? "admin",
      studio_id: input.studioId ?? null,
      target_type: input.targetType,
      target_id: input.targetId ?? null,
      action: input.action,
      outcome: input.outcome,
      source: input.source ?? "admin",
      request_id: input.requestId ?? null,
      metadata: sanitizeAdminAuditMetadata(input.metadata),
    });
    if (error) {
      console.error(
        JSON.stringify({
          event: "admin_action_audit_log_failed",
          action: input.action,
          outcome: input.outcome,
          code: error.code,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  } catch {
    console.error(
      JSON.stringify({
        event: "admin_action_audit_log_threw",
        action: input.action,
        timestamp: new Date().toISOString(),
      }),
    );
  }
}

export type AdminActionEventRow = {
  id: string;
  createdAt: string;
  actorEmail: string | null;
  actorUserId: string | null;
  actorRole: string | null;
  studioId: string | null;
  targetType: string;
  targetId: string | null;
  action: string;
  outcome: string;
  source: string;
  metadata: Record<string, unknown>;
};

// Read the most recent admin action events for the /admin audit view. Reads via
// service-role (the table denies all authenticated access); the calling page
// MUST be isAdmin-gated. FAIL-SOFT: returns [] on any error (incl. pre-migration
// table-missing) so the admin page degrades gracefully.
export async function getRecentAdminActionEvents(
  limit = 50,
): Promise<AdminActionEventRow[]> {
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("admin_action_events")
      .select(
        "id, created_at, actor_email, actor_user_id, actor_role, studio_id, target_type, target_id, action, outcome, source, metadata",
      )
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data.map((r) => ({
      id: r.id as string,
      createdAt: r.created_at as string,
      actorEmail: (r.actor_email as string | null) ?? null,
      actorUserId: (r.actor_user_id as string | null) ?? null,
      actorRole: (r.actor_role as string | null) ?? null,
      studioId: (r.studio_id as string | null) ?? null,
      targetType: r.target_type as string,
      targetId: (r.target_id as string | null) ?? null,
      action: r.action as string,
      outcome: r.outcome as string,
      source: r.source as string,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
    }));
  } catch {
    return [];
  }
}
