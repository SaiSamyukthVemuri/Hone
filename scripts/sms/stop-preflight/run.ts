import {
  evaluateInboundStopPreflight,
  STOP_PREFLIGHT_CHECKLIST_VERSION,
  type InboundStopFacts,
} from "../../../lib/sms/inbound-stop-preflight";
import { parseLiveRegistrationState, stopPreflightFor } from "../../../lib/sms/sender-registration";
import { configuredTwilioWebhookBase } from "../../../lib/sms/webhook-base";
import { sanitizeFacts } from "./facts";

// ===========================================================================
// HON-50 G6 operator script: evaluate a sender's inbound STOP path and, only
// when asked, RECORD exactly the evaluator's version-1 output through 0230.
// ===========================================================================
//
// Operator-run, local, service_role (docs/runbooks/sms-stop-preflight-record.md).
// Never imported by app code (pinned by tests/scripts/stop-preflight-script).
//
//   DRY RUN (default)  read the snapshot, evaluate, print codes. Writes nothing.
//   --record           the same, then record_studio_sms_stop_preflight with the
//                      checked_at compare-and-set read BEFORE evaluating, so a
//                      record that changed meanwhile is refused, not overwritten.
//
// Output is codes and ids only: check ids and pass/fail/unknown, never a
// detail string (they can carry URLs), a phone number, a SID or a token.

export type AdminLike = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type RunInput = {
  admin: AdminLike;
  studioId: string;
  raw: unknown;
  mode: "dry_run" | "record";
  context: "evidence" | "cutover";
  nowMs: number;
  /** Non-secret credentials epoch (HON-50 open question); null when not used. */
  credentialsEpoch?: string | null;
};

export type RunResult = {
  result:
    | "invalid_arguments"
    | "facts_refused"
    | "snapshot_unreadable"
    | "no_active_sender"
    | "ambiguous_active_sender"
    | "sender_identity_missing"
    | "evaluated"
    | "cannot_record_without_webhook_base"
    | "recorded"
    | "record_refused"
    | "outcome_unknown";
  code?: string;
  senderId?: string;
  ready?: boolean;
  checks?: Array<{ id: string; status: string }>;
  blockers?: string[];
  malformed?: string[];
  ignored?: string[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EPOCH = /^[A-Za-z0-9._-]{1,64}$/;

export async function runStopPreflight(input: RunInput): Promise<RunResult> {
  if (
    !UUID.test(input.studioId) ||
    (input.mode !== "dry_run" && input.mode !== "record") ||
    (input.context !== "evidence" && input.context !== "cutover") ||
    (input.credentialsEpoch != null && !EPOCH.test(input.credentialsEpoch))
  ) {
    return { result: "invalid_arguments" };
  }

  const sanitized = sanitizeFacts(input.raw, input.nowMs);
  if ("refused" in sanitized) return { result: "facts_refused", code: sanitized.refused };

  // The sender, its service and its current preflight: ONE snapshot. The CAS
  // token is read here, before anything is evaluated.
  let snapshot: unknown;
  try {
    const { data, error } = await input.admin.rpc("get_live_studio_sms_sender_registration_state", {
      p_studio_id: input.studioId,
    });
    if (error) return { result: "snapshot_unreadable" };
    snapshot = data;
  } catch {
    return { result: "snapshot_unreadable" };
  }
  const state = parseLiveRegistrationState(snapshot, input.studioId);
  if (!state.ok) return { result: "snapshot_unreadable" };
  const active = state.senders.filter((s) => s.status === "active");
  if (active.length === 0) return { result: "no_active_sender" };
  if (active.length > 1) return { result: "ambiguous_active_sender" };
  const sender = active[0];
  if (!sender.phone_number || !sender.messaging_service_sid) {
    return { result: "sender_identity_missing", senderId: sender.id };
  }
  const expectedCheckedAt = stopPreflightFor(state, sender.id)?.checkedAt ?? null;

  // The service -> studio mapping (0191), read-only. Unreadable = not read.
  let mappedStudioId: string | null | undefined;
  try {
    const { data, error } = await input.admin.rpc("resolve_studio_by_sms_messaging_service", {
      p_messaging_service_sid: sender.messaging_service_sid,
    });
    mappedStudioId = error ? undefined : typeof data === "string" ? data : null;
  } catch {
    mappedStudioId = undefined;
  }

  // SERVICE EVIDENCE MUST BE THIS SENDER'S (Codex P2 4305512201). The database
  // is the identity authority, but facts copied from another Messaging Service
  // or number must not be combined with this sender's identity: unless the
  // file names this sender's service AND number, every service fact is dropped,
  // so the checks they feed are unknown and nothing can pass on them.
  const fileService = sanitized.facts.service;
  const serviceMatches =
    sanitized.serviceEvidence.sid === sender.messaging_service_sid &&
    sanitized.serviceEvidence.checkedNumber === sender.phone_number;
  const dropped: string[] = [];
  const hasServiceEvidence =
    (fileService !== undefined && Object.keys(fileService).length > 0) || sanitized.facts.optOutConfiguration !== undefined;
  if (hasServiceEvidence && !serviceMatches) {
    dropped.push(
      sanitized.serviceEvidence.sid === undefined || sanitized.serviceEvidence.checkedNumber === undefined
        ? "service_evidence_unlabelled"
        : "service_evidence_for_another_sender",
    );
  }
  const facts: InboundStopFacts = {
    ...sanitized.facts,
    // The opt-out setting belongs to the Messaging Service too, so it is bound
    // with the other service facts. Account-wide facts (Webhook Rules, Static
    // Proxy, edge zones, propagation) and deployment facts are not per sender,
    // and the live STOP is bound to this sender by the evaluator itself.
    optOutConfiguration: serviceMatches ? sanitized.facts.optOutConfiguration : undefined,
    service: {
      ...(serviceMatches ? (fileService ?? {}) : {}),
      sid: sender.messaging_service_sid,
      checkedNumber: sender.phone_number,
    },
    // Routed sends pin the checked sender's own number as From (#858).
    routedFromNumber: sender.phone_number,
    mappedStudioId,
    expectedStudioId: input.studioId,
  };
  const evaluation = evaluateInboundStopPreflight(facts);
  const checks = evaluation.checks.map((c) => ({ id: c.id, status: c.status }));
  const base: RunResult = {
    result: "evaluated",
    senderId: sender.id,
    ready: evaluation.ready,
    checks,
    blockers: evaluation.blockers,
    malformed: [...sanitized.malformed, ...dropped],
    ignored: sanitized.ignored,
  };
  if (input.mode === "dry_run") return base;

  const webhookBase = configuredTwilioWebhookBase(facts.env);
  if (!webhookBase) return { ...base, result: "cannot_record_without_webhook_base" };

  let row: { result?: string } | undefined;
  try {
    const { data, error } = await input.admin.rpc("record_studio_sms_stop_preflight", {
      p_studio_id: input.studioId,
      p_expected_sender_id: sender.id,
      p_expected_phone: sender.phone_number,
      p_messaging_service_sid: sender.messaging_service_sid,
      p_checks: checks,
      p_checklist_version: STOP_PREFLIGHT_CHECKLIST_VERSION,
      p_webhook_base: webhookBase,
      p_credentials_epoch: input.credentialsEpoch ?? null,
      p_credentials_active_since: facts.signatureProof?.credentialsActiveSince ?? null,
      p_context: input.context,
      p_expected_checked_at: expectedCheckedAt,
    });
    if (error) return { ...base, result: "outcome_unknown" };
    row = Array.isArray(data) ? (data[0] as { result?: string }) : (data as { result?: string } | undefined);
  } catch {
    // The write may have committed: never report it as not recorded.
    return { ...base, result: "outcome_unknown" };
  }
  if (!row?.result) return { ...base, result: "outcome_unknown" };
  if (row.result !== "recorded") return { ...base, result: "record_refused", code: row.result };
  return { ...base, result: "recorded" };
}

/**
 * The script targets a LOCAL Supabase unless hosting is explicitly approved:
 * the --allow-hosted flag AND HONE_STOP_PREFLIGHT_HOSTED_APPROVED=yes (set only
 * for a Sam-approved cutover, per the runbook). Anything else is refused.
 */
export function targetAllowed(
  supabaseUrl: string | undefined,
  allowHostedFlag: boolean,
  env: Readonly<Record<string, string | undefined>>,
): { ok: true; hosted: boolean } | { ok: false; code: "no_supabase_url" | "unparseable_supabase_url" | "hosted_not_approved" } {
  if (!supabaseUrl) return { ok: false, code: "no_supabase_url" };
  let host: string;
  try {
    host = new URL(supabaseUrl).hostname;
  } catch {
    return { ok: false, code: "unparseable_supabase_url" };
  }
  const local = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (local) return { ok: true, hosted: false };
  if (allowHostedFlag && env.HONE_STOP_PREFLIGHT_HOSTED_APPROVED === "yes") return { ok: true, hosted: true };
  return { ok: false, code: "hosted_not_approved" };
}
