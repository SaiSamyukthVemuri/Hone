import type { SupabaseClient } from "@supabase/supabase-js";

// The over-invite batch's database port: typed wrappers over the 0363 commands (create, preview, claim, admit with a batch item, settle, replace).
// Every command is service_role-only, so the caller passes the SERVICE client; the actor id is the confirming owner's AUTH user id, resolved from
// the session by the caller, never read from a request.
//
// NOTHING HERE LOGS, and no error body is returned: a failure is a fixed code, because the admit and replace rows carry a delivery email, a name and
// the raw token, and none of the three may reach a log, a redirect or an error. They are returned to the one caller that delivers, and nowhere else.

type Rpc = Pick<SupabaseClient, "rpc">;

const FN_ABSENT = new Set(["PGRST202", "42883"]);

export type PortFailure = { ok: false; code: "unavailable" | "not_applied" | "bad_shape" };

function failure(error: { code?: string } | null): PortFailure {
  return { ok: false, code: error && FN_ABSENT.has(String(error.code)) ? "not_applied" : "unavailable" };
}

function rows(data: unknown): Record<string, unknown>[] | null {
  if (data === null || data === undefined) return [];
  const list = Array.isArray(data) ? data : [data];
  return list.every((r) => typeof r === "object" && r !== null) ? (list as Record<string, unknown>[]) : null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);

// ---- create ---------------------------------------------------------------------------------------------------------------------------------

export const CREATE_RESULTS = [
  "created",
  "exists",
  "key_reused",
  "not_owner",
  "confirmation_required",
  "invalid_input",
  "invalid_entries",
  "entry_in_other_batch",
  "material_change",
] as const;
export type CreateResult = (typeof CREATE_RESULTS)[number];

export type CreateBatchInput = {
  studioId: string;
  actorUserId: string;
  batchKey: string;
  entryIds: readonly string[];
  serviceId: string;
  startDate: string;
  endDate: string;
  allowedWeekdays: readonly number[] | null;
  ttlHours: number;
  fit: number;
  shownLiveCount: number;
  confirmed: boolean;
};

export type CreateBatchOutcome =
  | { ok: true; result: CreateResult; batchId: string | null; quantity: number | null; extraRequested: number | null; liveCount: number | null }
  | PortFailure;

export async function createBatch(db: Rpc, input: CreateBatchInput): Promise<CreateBatchOutcome> {
  const { data, error } = await db.rpc("create_waitlist_invitation_batch", {
    p_studio_id: input.studioId,
    p_actor_user_id: input.actorUserId,
    p_batch_key: input.batchKey,
    p_entry_ids: [...input.entryIds],
    p_service_id: input.serviceId,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_allowed_weekdays: input.allowedWeekdays === null ? null : [...input.allowedWeekdays],
    p_ttl_hours: input.ttlHours,
    p_fit: input.fit,
    p_shown_live_count: input.shownLiveCount,
    p_confirmed: input.confirmed,
  });
  if (error) return failure(error);
  const list = rows(data);
  const row = list?.[0];
  const result = str(row?.result);
  if (!row || !result || !(CREATE_RESULTS as readonly string[]).includes(result)) return { ok: false, code: "bad_shape" };
  return {
    ok: true,
    result: result as CreateResult,
    batchId: str(row.batch_id),
    quantity: int(row.quantity),
    extraRequested: int(row.extra_requested),
    liveCount: int(row.live_count),
  };
}

// ---- preview --------------------------------------------------------------------------------------------------------------------------------

export type PreviewOutcome =
  | { ok: true; result: "ok"; liveCount: number; expiringWithin24h: number; selected: number; admissible: number }
  | { ok: true; result: "not_owner" | "invalid_input" }
  | PortFailure;

export async function previewSelection(
  db: Rpc,
  input: { studioId: string; actorUserId: string; entryIds: readonly string[]; startDate: string; endDate: string; allowedWeekdays: readonly number[] | null },
): Promise<PreviewOutcome> {
  const { data, error } = await db.rpc("preview_waitlist_over_invite", {
    p_studio_id: input.studioId,
    p_actor_user_id: input.actorUserId,
    p_entry_ids: [...input.entryIds],
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_allowed_weekdays: input.allowedWeekdays === null ? null : [...input.allowedWeekdays],
  });
  if (error) return failure(error);
  const row = rows(data)?.[0];
  const result = str(row?.result);
  if (!row || !result) return { ok: false, code: "bad_shape" };
  if (result === "not_owner" || result === "invalid_input") return { ok: true, result };
  const live = int(row.live_count);
  const exp = int(row.expiring_within_24h);
  const sel = int(row.selected);
  const adm = int(row.admissible);
  if (result !== "ok" || live === null || exp === null || sel === null || adm === null) return { ok: false, code: "bad_shape" };
  return { ok: true, result: "ok", liveCount: live, expiringWithin24h: exp, selected: sel, admissible: adm };
}

// ---- claim ----------------------------------------------------------------------------------------------------------------------------------

export type ClaimedItem = {
  itemId: string;
  batchId: string;
  studioId: string;
  entryId: string;
  actorUserId: string;
  serviceId: string;
  startDate: string;
  endDate: string;
  allowedWeekdays: number[] | null;
  ttlHours: number;
};

export type ClaimOutcome = { ok: true; items: ClaimedItem[] } | PortFailure;

/** Claim runs per studio round-robin with a lease. The caller passes sane limits; the database returns NOTHING for a limit below its floor. */
export async function claimItems(db: Rpc, input: { perStudio: number; total: number; leaseSeconds: number }): Promise<ClaimOutcome> {
  const { data, error } = await db.rpc("claim_waitlist_batch_items", {
    p_per_studio: input.perStudio,
    p_total: input.total,
    p_lease_seconds: input.leaseSeconds,
    // NEVER a time argument: the claim's clock is the database's.
  });
  if (error) return failure(error);
  const list = rows(data);
  if (list === null) return { ok: false, code: "bad_shape" };
  const items: ClaimedItem[] = [];
  for (const r of list) {
    const w = r.allowed_weekdays;
    const item: ClaimedItem = {
      itemId: str(r.item_id) ?? "",
      batchId: str(r.batch_id) ?? "",
      studioId: str(r.studio_id) ?? "",
      entryId: str(r.entry_id) ?? "",
      actorUserId: str(r.actor_user_id) ?? "",
      serviceId: str(r.service_id) ?? "",
      startDate: str(r.start_date) ?? "",
      endDate: str(r.end_date) ?? "",
      allowedWeekdays: Array.isArray(w) && w.every((d) => Number.isInteger(d)) ? (w as number[]) : null,
      ttlHours: int(r.ttl_hours) ?? 0,
    };
    if (!item.itemId || !item.entryId || !item.studioId || !item.actorUserId || !item.serviceId || item.ttlHours < 1) {
      return { ok: false, code: "bad_shape" };
    }
    items.push(item);
  }
  return { ok: true, items };
}

// ---- admit (batch-aware) and replace --------------------------------------------------------------------------------------------------------

/** The delivery facts an admit or replace returns ONCE. Held in memory by the one caller that delivers; never logged or returned onward. */
export type IssuedInvitation = {
  invitationId: string;
  rawToken: string;
  issuedAt: Date;
  expiresAt: Date;
  deliveryEmail: string | null;
  deliveryName: string | null;
};

export type AdmitOutcome =
  | { ok: true; result: "admitted"; issued: IssuedInvitation }
  | { ok: true; result: string }
  | PortFailure;

// CLOSED SETS. A command's result is mapped into one of these or into "refused": free text from the database (replace used to answer "refused:" plus
// text) is never returned, shown or logged, and a code this app does not know cannot widen what flows onward.
export const ADMIT_REFUSAL_CODES = [
  "no_capacity", "invalid_fit", "invalid_service", "not_found", "not_admissible", "pending_owner_review", "unknown_studio", "batch_item_invalid",
  "already_invited", "already_declined_offer", "invalid_ttl", "invalid_scope_dates", "no_round_open", "round_full", "not_owner", "invalid_input",
] as const;
export const REPLACE_REFUSAL_CODES = [
  "not_owner", "not_found", "no_live_invitation", "invitation_redeemed", "invalid_service", "pending_owner_review",
] as const;
const closed = (result: string, set: readonly string[]): string => (set.includes(result) ? result : "refused");

function issued(r: Record<string, unknown>): IssuedInvitation | null {
  const invitationId = str(r.invitation_id);
  const rawToken = str(r.raw_token);
  const issuedAt = str(r.issued_at);
  const expiresAt = str(r.expires_at);
  if (!invitationId || !rawToken || !issuedAt || !expiresAt) return null;
  const a = new Date(issuedAt);
  const b = new Date(expiresAt);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  return { invitationId, rawToken, issuedAt: a, expiresAt: b, deliveryEmail: str(r.delivery_email), deliveryName: str(r.delivery_name) };
}

export async function admitBatchItem(db: Rpc, item: ClaimedItem, fit: number | null): Promise<AdmitOutcome> {
  const { data, error } = await db.rpc("admit_new_client_waitlist_entry", {
    p_studio_id: item.studioId,
    p_actor_user_id: item.actorUserId,
    p_entry_id: item.entryId,
    p_service_id: item.serviceId,
    p_start_date: item.startDate,
    p_end_date: item.endDate,
    p_allowed_weekdays: item.allowedWeekdays,
    p_ttl_hours: item.ttlHours,
    p_fit: fit,
    p_batch_item_id: item.itemId,
  });
  if (error) return failure(error);
  const row = rows(data)?.[0];
  const result = str(row?.result);
  if (!row || !result) return { ok: false, code: "bad_shape" };
  if (result !== "admitted") return { ok: true, result: closed(result, ADMIT_REFUSAL_CODES) };
  const got = issued(row);
  return got ? { ok: true, result: "admitted", issued: got } : { ok: false, code: "bad_shape" };
}

export type ReplaceOutcome =
  | { ok: true; result: "replaced"; issued: IssuedInvitation }
  | { ok: true; result: string }
  | PortFailure;

export async function replaceInvitation(db: Rpc, input: { studioId: string; actorUserId: string; entryId: string }): Promise<ReplaceOutcome> {
  const { data, error } = await db.rpc("replace_waitlist_invitation", {
    p_studio_id: input.studioId,
    p_actor_user_id: input.actorUserId,
    p_entry_id: input.entryId,
  });
  if (error) return failure(error);
  const row = rows(data)?.[0];
  const result = str(row?.result);
  if (!row || !result) return { ok: false, code: "bad_shape" };
  if (result !== "replaced") return { ok: true, result: closed(result, REPLACE_REFUSAL_CODES) };
  const got = issued({ ...row, delivery_email: null, delivery_name: null });
  return got ? { ok: true, result: "replaced", issued: got } : { ok: false, code: "bad_shape" };
}

// ---- settle ---------------------------------------------------------------------------------------------------------------------------------

export type SettleOutcome = { ok: true; result: string } | PortFailure;
const REASON = /^[a-z_]{1,40}$/;

/** `failed` and `skipped` REQUIRE a reason class; it is a fixed code, never free text and never a name. */
export type SettleTarget = { itemId: string; studioId: string; entryId: string };

/** The item must belong to BOTH the studio and the entry named (0363): a mismatch answers not_found and changes nothing. Pass them from the claimed row. */
export async function settleItem(db: Rpc, target: SettleTarget, outcome: "sent" | "failed" | "unknown" | "skipped", reasonClass: string | null): Promise<SettleOutcome> {
  if (outcome !== "sent" && (reasonClass === null || !REASON.test(reasonClass))) return { ok: false, code: "bad_shape" };
  const { data, error } = await db.rpc("settle_waitlist_batch_item", {
    p_item_id: target.itemId,
    p_studio_id: target.studioId,
    p_entry_id: target.entryId,
    p_outcome: outcome,
    p_reason_class: reasonClass,
  });
  if (error) return failure(error);
  const result = str(data);
  return result ? { ok: true, result } : { ok: false, code: "bad_shape" };
}

// ---- stop -----------------------------------------------------------------------------------------------------------------------------------

export type StopOutcome = { ok: true; result: "stopped" | "nothing_pending" | "not_owner" | "not_found" | "invalid_input"; cancelled: number } | PortFailure;

/** Owner-only. Moves the batch's pending (and lease-expired claimed, never-issued) items to skipped 'owner_stopped'; in-flight items finish. */
export async function stopBatch(db: Rpc, input: { studioId: string; actorUserId: string; batchId: string; leaseSeconds: number }): Promise<StopOutcome> {
  const { data, error } = await db.rpc("stop_waitlist_batch", {
    p_studio_id: input.studioId,
    p_actor_user_id: input.actorUserId,
    p_batch_id: input.batchId,
    p_lease_seconds: input.leaseSeconds,
  });
  if (error) return failure(error);
  const row = rows(data)?.[0];
  const result = str(row?.result);
  const known = ["stopped", "nothing_pending", "not_owner", "not_found", "invalid_input"] as const;
  if (!row || !result || !(known as readonly string[]).includes(result)) return { ok: false, code: "bad_shape" };
  return { ok: true, result: result as (typeof known)[number], cancelled: int(row.cancelled) ?? 0 };
}
