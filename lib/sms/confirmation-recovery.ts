import type { SupabaseClient } from "@supabase/supabase-js";
import type { Client, Studio } from "@/lib/types/database";
import {
  listedRoutingStudioIds,
  liveSendTimeRouteReader,
  type SendTimeRouteRead,
  type SendTimeRouteReader,
} from "./send-time-route";
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
// sent_at; recovery only takes attempts = 0; and the appointment is re-read
// BEFORE the claim (a refusal or an unreadable row spends nothing, so it stays
// owed) and AFTER it (still confirmed, still beyond the horizon) before the
// provider is called. A reschedule creates a new row, so the old one is no
// longer `confirmed` and is never confirmed late. Residual: if the post-claim
// re-read fails on every look, the claim is released with its attempt spent
// and that confirmation is no longer owed. Closing that needs an atomic
// validate-and-claim command (0206's pattern), i.e. a migration.
//
// FAIRNESS. Each listed studio is paged separately (keyset on created_at,
// RECOVERY_PAGE_SIZE rows, at most RECOVERY_MAX_PAGES_PER_STUDIO pages), so
// rows that keep refusing (an opted-out client, an unready sender) can neither
// starve newer rows of the same studio nor another studio. Each studio's
// sender snapshot is read ONCE per run, and a route is looked at once per row:
// the next run is the retry. Rows sharing a created_at across a page boundary
// are left to the next run.
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
export const RECOVERY_PAGE_SIZE = 50;
export const RECOVERY_MAX_PAGES_PER_STUDIO = 10;
export const RECOVERY_MAX_SENDS_PER_RUN = 50;
/** Post-claim re-read looks on a read failure, before releasing the claim. */
export const RECOVERY_POST_CLAIM_LOOKS = 3;

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
  pageSize?: number;
}): Promise<RecoveryRun> {
  const env = opts.env ?? process.env;
  if (!confirmationRecoveryEnabled(env)) return { ran: false, reason: "disabled" };
  const studioIds = listedRoutingStudioIds(env);
  if (studioIds.length === 0) return { ran: false, reason: "no_routed_studios" };

  // One snapshot per studio per run, failures included.
  const base = opts.routeReader ?? liveSendTimeRouteReader(opts.admin);
  const snapshots = new Map<string, Promise<SendTimeRouteRead>>();
  const reader: SendTimeRouteReader = (studioId) => {
    let p = snapshots.get(studioId);
    if (!p) {
      p = base(studioId).catch(() => ({ ok: false }) as const);
      snapshots.set(studioId, p);
    }
    return p;
  };

  const w = owedWindow(opts.nowMs);
  const pageSize = opts.pageSize ?? RECOVERY_PAGE_SIZE;
  const run = { ran: true as const, considered: 0, sent: 0, failed: 0, skipped: {} as Record<string, number> };
  const skip = (reason: string) => {
    run.skipped[reason] = (run.skipped[reason] ?? 0) + 1;
  };
  let anyRead = false;

  studios: for (const studioId of studioIds) {
    let after: string | null = null;
    for (let page = 0; page < RECOVERY_MAX_PAGES_PER_STUDIO; page += 1) {
      if (run.sent >= RECOVERY_MAX_SENDS_PER_RUN) break studios;
      const rows = await readOwedPage(opts.admin, studioId, w, after, pageSize);
      if (rows === null) {
        skip("read_failed");
        continue studios;
      }
      anyRead = true;
      for (const row of rows) {
        if (run.sent >= RECOVERY_MAX_SENDS_PER_RUN) break studios;
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
            routeReader: reader,
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
      if (rows.length < pageSize) continue studios;
      after = rows[rows.length - 1].created_at;
    }
  }
  if (!anyRead) return { ran: false, reason: "read_failed" };
  return run;
}

/** One keyset page of one studio's owed rows, oldest first; null when unreadable. */
async function readOwedPage(
  admin: SupabaseClient,
  studioId: string,
  w: ReturnType<typeof owedWindow>,
  after: string | null,
  pageSize: number,
): Promise<OwedConfirmationRow[] | null> {
  try {
    let q = admin
      .from("appointments")
      .select(
        "id, studio_id, status, starts_at, created_at, sms_confirmation_sent_at, sms_confirmation_send_attempts, sms_confirmation_claimed_at, studio:studios(id, name, timezone, send_confirmation_sms, send_24h_sms_reminders, send_2h_sms_reminders), client:clients(phone, sms_consent_at, sms_opted_out_at)",
      )
      .eq("studio_id", studioId)
      .eq("status", "confirmed")
      .is("sms_confirmation_sent_at", null)
      .eq("sms_confirmation_send_attempts", 0)
      .is("sms_confirmation_claimed_at", null)
      .gte("created_at", w.createdAfterIso)
      .lte("created_at", w.createdBeforeIso)
      .gt("starts_at", w.startsAfterIso);
    if (after) q = q.gt("created_at", after);
    const { data, error } = await q.order("created_at", { ascending: true }).limit(pageSize);
    if (error || !Array.isArray(data)) return null;
    const one = <T>(v: T | T[] | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : v);
    return data.map((r) => {
      const row = r as unknown as OwedConfirmationRow;
      return { ...row, studio: one(row.studio as never), client: one(row.client as never) };
    });
  } catch {
    return null;
  }
}

/** After the claim: still confirmed, and still starting beyond the horizon. */
async function revalidateOwed(
  admin: SupabaseClient,
  appointmentId: string,
  nowMs: number,
): Promise<{ ok: true; startsAt: Date } | { ok: false; reason: string }> {
  // An unreadable answer is looked at again; only a READ verdict refuses.
  let row: { status: string; starts_at: string } | null = null;
  for (let look = 0; look < RECOVERY_POST_CLAIM_LOOKS && !row; look += 1) {
    try {
      const { data, error } = await admin
        .from("appointments")
        .select("status, starts_at")
        .eq("id", appointmentId)
        .maybeSingle();
      if (!error && data) row = data as { status: string; starts_at: string };
    } catch {
      // looked at again below
    }
  }
  if (!row) return { ok: false, reason: "recovery_revalidate_failed" };
  if (row.status !== "confirmed") return { ok: false, reason: "recovery_not_confirmed" };
  const startsAt = new Date(row.starts_at);
  if (!Number.isFinite(startsAt.getTime()) || startsAt.getTime() <= nowMs + RECOVERY_MIN_LEAD_MS) {
    return { ok: false, reason: "recovery_too_late" };
  }
  return { ok: true, startsAt };
}
