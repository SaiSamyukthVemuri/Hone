import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client, Studio } from "@/lib/types/database";
import { listedRoutingStudioIds, type SendTimeRouteReader } from "./send-time-route";
import { sendRecoveredConfirmationSmsToClient, type SmsSendResult } from "./send-appointment";

// ===========================================================================
// D5 (WILLOW-ROUTING-CANDIDATE-01, #824): an OWED booking confirmation.
// ===========================================================================
//
// THE GAP. A confirmation is one-shot: booking, calendar, reschedule and
// portal rebook each call sendBookingConfirmationSmsToClient ONCE for their
// new appointment row and discard the result, and nothing rescans. For a
// studio routed through its own sender, a confirmation refused because that
// sender was not ready yet (claimed nothing, spent no attempt) was never sent.
//
// THE RULE. A confirmation is OWED while all of these hold:
//   * its studio is listed for routing (platform-routed studios keep today's
//     behaviour exactly; nothing here reads or sends for them);
//   * the appointment is `confirmed`;
//   * NO provider attempt was ever made: sent_at null, attempts 0, no claim.
//     Any attempt -- sent, failed, or possibly sent -- ends recovery for good;
//   * it was booked within RECOVERY_MAX_AGE_MS, and at least
//     RECOVERY_GRACE_MS ago (the booking request's own send has finished);
//   * it starts more than RECOVERY_MIN_LEAD_MS from now, i.e. after the 2h
//     reminder's window, so a late confirmation never lands on top of it.
// An owed confirmation is delivered on the first run where EVERY send-time
// gate passes again: the studio's switch, the client's consent and STOP (read
// fresh), the fence, and the studio's sender and destination readiness. A
// refusal leaves it owed until it expires.
//
// DUPLICATES. claim_sms_send (0049) admits one claim at a time and never after
// sent_at; recovery only takes attempts = 0; and after the claim the
// appointment is re-read (still confirmed, still beyond the horizon) before
// the provider is called. A reschedule creates a new row, so the old one is
// no longer `confirmed` and is never confirmed late.
//
// ACTIVATION. Off unless SMS_CONFIRMATION_RECOVERY=on AND the studio is
// listed in SMS_STUDIO_ROUTING_STUDIO_IDS. Both are unset everywhere, and the
// route that runs this (app/api/cron/sms-confirmation-recovery) is on no
// scheduler. Disabled, it reads nothing.
// ===========================================================================

export const CONFIRMATION_RECOVERY_ENV = "SMS_CONFIRMATION_RECOVERY";
export const RECOVERY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_GRACE_MS = 5 * 60 * 1000;
/** The 2h reminder window ends 2h15m out (lib/cron/reminder-schedule). */
export const RECOVERY_MIN_LEAD_MS = (2 * 60 + 15) * 60 * 1000;
export const RECOVERY_PER_RUN_LIMIT = 50;

type Env = Readonly<Record<string, string | undefined>>;

export function confirmationRecoveryEnabled(env: Env = process.env): boolean {
  return env[CONFIRMATION_RECOVERY_ENV] === "on";
}

export type OwedConfirmationRow = {
  id: string;
  studio_id: string;
  status: string;
  starts_at: string;
  created_at: string;
  sms_confirmation_sent_at: string | null;
  sms_confirmation_send_attempts: number;
  sms_confirmation_claimed_at: string | null;
  studio: Pick<
    Studio,
    "id" | "name" | "timezone" | "send_confirmation_sms" | "send_24h_sms_reminders" | "send_2h_sms_reminders"
  > | null;
  client: Pick<Client, "phone" | "sms_consent_at" | "sms_opted_out_at"> | null;
};

export function owedWindow(nowMs: number) {
  return {
    createdAfterIso: new Date(nowMs - RECOVERY_MAX_AGE_MS).toISOString(),
    createdBeforeIso: new Date(nowMs - RECOVERY_GRACE_MS).toISOString(),
    startsAfterIso: new Date(nowMs + RECOVERY_MIN_LEAD_MS).toISOString(),
  };
}

/** The rule above, applied to one row. The query asks the same; this re-checks. */
export function isOwedConfirmation(row: OwedConfirmationRow, nowMs: number, studioIds: readonly string[]): boolean {
  const created = Date.parse(row.created_at);
  const starts = Date.parse(row.starts_at);
  return (
    studioIds.includes(row.studio_id) &&
    row.studio?.id === row.studio_id &&
    row.status === "confirmed" &&
    row.sms_confirmation_sent_at === null &&
    row.sms_confirmation_send_attempts === 0 &&
    row.sms_confirmation_claimed_at === null &&
    Number.isFinite(created) &&
    Number.isFinite(starts) &&
    created >= nowMs - RECOVERY_MAX_AGE_MS &&
    created <= nowMs - RECOVERY_GRACE_MS &&
    starts > nowMs + RECOVERY_MIN_LEAD_MS
  );
}

export type RecoveryRun =
  | { ran: false; reason: "disabled" | "no_routed_studios" }
  | { ran: false; reason: "read_failed" }
  | { ran: true; considered: number; sent: number; failed: number; skipped: Record<string, number> };

/** One recovery pass. Never throws. */
export async function recoverOwedConfirmations(opts: {
  admin: SupabaseClient;
  nowMs: number;
  manageUrlFor: (appointmentId: string, startsAt: Date) => string | null;
  env?: Env;
  routeReader?: SendTimeRouteReader;
  limit?: number;
}): Promise<RecoveryRun> {
  const env = opts.env ?? process.env;
  if (!confirmationRecoveryEnabled(env)) return { ran: false, reason: "disabled" };
  const studioIds = listedRoutingStudioIds(env);
  if (studioIds.length === 0) return { ran: false, reason: "no_routed_studios" };

  const w = owedWindow(opts.nowMs);
  let rows: OwedConfirmationRow[];
  try {
    const { data, error } = await opts.admin
      .from("appointments")
      .select(
        "id, studio_id, status, starts_at, created_at, sms_confirmation_sent_at, sms_confirmation_send_attempts, sms_confirmation_claimed_at, studio:studios(id, name, timezone, send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders), client:clients(phone, sms_consent_at, sms_opted_out_at)",
      )
      .in("studio_id", studioIds)
      .eq("status", "confirmed")
      .is("sms_confirmation_sent_at", null)
      .eq("sms_confirmation_send_attempts", 0)
      .is("sms_confirmation_claimed_at", null)
      .gte("created_at", w.createdAfterIso)
      .lte("created_at", w.createdBeforeIso)
      .gt("starts_at", w.startsAfterIso)
      .order("created_at", { ascending: true })
      .limit(opts.limit ?? RECOVERY_PER_RUN_LIMIT);
    if (error || !Array.isArray(data)) return { ran: false, reason: "read_failed" };
    rows = data.map((r) => {
      const row = r as unknown as OwedConfirmationRow & { studio: unknown; client: unknown };
      const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
      return { ...row, studio: one(row.studio as never), client: one(row.client as never) };
    });
  } catch {
    return { ran: false, reason: "read_failed" };
  }

  const run = { ran: true as const, considered: 0, sent: 0, failed: 0, skipped: {} as Record<string, number> };
  const skip = (reason: string) => {
    run.skipped[reason] = (run.skipped[reason] ?? 0) + 1;
  };

  for (const row of rows) {
    run.considered += 1;
    if (!isOwedConfirmation(row, opts.nowMs, studioIds) || !row.studio || !row.client) {
      skip("not_owed");
      continue;
    }
    let result: SmsSendResult;
    try {
      result = await sendRecoveredConfirmationSmsToClient({
        admin: opts.admin,
        appointmentId: row.id,
        timezone: row.studio.timezone,
        studio: row.studio,
        client: row.client,
        routeReader: opts.routeReader,
        manageUrlFor: (startsAt) => opts.manageUrlFor(row.id, startsAt),
        revalidate: () => revalidateOwed(opts.admin, row.id, opts.nowMs),
      });
    } catch {
      result = { ok: false, error: "recovery_threw", retryable: false };
    }
    if (result.ok) run.sent += 1;
    else if (result.skipped) skip(result.reason);
    else run.failed += 1;
  }
  return run;
}

/** After the claim: still confirmed, and still starting beyond the horizon. */
async function revalidateOwed(
  admin: SupabaseClient,
  appointmentId: string,
  nowMs: number,
): Promise<{ ok: true; startsAt: Date } | { ok: false; reason: string }> {
  const { data, error } = await admin
    .from("appointments")
    .select("status, starts_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error || !data) return { ok: false, reason: "recovery_revalidate_failed" };
  const row = data as { status: string; starts_at: string };
  if (row.status !== "confirmed") return { ok: false, reason: "recovery_not_confirmed" };
  const startsAt = new Date(row.starts_at);
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= nowMs + RECOVERY_MIN_LEAD_MS) {
    return { ok: false, reason: "recovery_too_late" };
  }
  return { ok: true, startsAt };
}
