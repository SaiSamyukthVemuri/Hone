import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReminderScanCursor } from "@/lib/cron/reminder-scan-coordinator";

// The appointment-reminders cron's candidate query, extracted so a database
// test can run the EXACT builder the route runs against the real chain
// (MSG-ARCH-01: an embedded-filter typo would silently select nothing, and a
// fake client cannot show that). The route owns everything after the read.
export const PER_RUN_LIMIT = 50;
export const MAX_ATTEMPTS = 3;

// Widened to accept SMS column names too. The same join shape works
// for both email and SMS passes; the difference is purely which
// _sent_at / _send_attempts columns we filter on.
type SentColumn =
  | "reminder_24h_sent_at"
  | "reminder_2h_sent_at"
  | "sms_reminder_24h_sent_at"
  | "sms_reminder_2h_sent_at";
type AttemptsColumn =
  | "reminder_24h_send_attempts"
  | "reminder_2h_send_attempts"
  | "sms_reminder_24h_send_attempts"
  | "sms_reminder_2h_send_attempts";

export function buildReminderCandidateQuery(
  admin: SupabaseClient,
  opts: {
    startIso: string;
    endIso: string;
    notSentColumn: SentColumn;
    attemptsColumn: AttemptsColumn;
    after: ReminderScanCursor | null;
    limit: number;
    signal: AbortSignal;
  },
) {
  let query = admin
    .from("appointments")
    .select(
      "*, service:services(name, default_duration_minutes, pre_care_instructions), studio:studios(*), client:clients!inner(name, email, phone, sms_consent_at, sms_opted_out_at, archived_at), practitioner:practitioners!appointments_practitioner_same_studio_fk(display_name, email)",
    )
    .eq("status", "confirmed")
    // MSG-ARCH-01: archived clients are filtered in the query (inner join), so
    // their visits never consume the per-run candidate and query budget or get
    // re-scanned every fire. The send-time re-reads below still cover a client
    // archived AFTER discovery.
    .is("client.archived_at", null)
    .is(opts.notSentColumn, null)
    .lt(opts.attemptsColumn, MAX_ATTEMPTS)
    .gte("starts_at", opts.startIso)
    .lte("starts_at", opts.endIso)
    .order("starts_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.min(PER_RUN_LIMIT, opts.limit))
    .abortSignal(opts.signal);
  if (opts.after) {
    // A total keyset order survives rows leaving the candidate set as this
    // pass records results. OFFSET would skip unsent work after those writes.
    const time = JSON.stringify(opts.after.startsAt);
    const id = JSON.stringify(opts.after.id);
    query = query.or(`starts_at.gt.${time},and(starts_at.eq.${time},id.gt.${id})`);
  }
  return query;
}
