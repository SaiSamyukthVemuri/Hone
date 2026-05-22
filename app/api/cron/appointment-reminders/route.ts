import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  send24hReminderToClient,
  send2hReminderToClient,
} from "@/lib/email/send-appointment";
import {
  buildTreatmentTimeLine,
  getTreatmentTimeContextForEmail,
} from "@/lib/treatment-time/queries";
import type { Appointment, Service, Studio } from "@/lib/types/database";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const PER_RUN_LIMIT = 50;
const MAX_ATTEMPTS = 3;

type Joined = Appointment & {
  service: Pick<Service, "name" | "default_duration_minutes" | "pre_care_instructions"> | null;
  studio: Studio | null;
  client: { name: string; email: string | null } | null;
  practitioner: { display_name: string | null; email: string | null } | null;
};

function pickRel<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

async function loadAppointmentsForWindow(opts: {
  startIso: string;
  endIso: string;
  notSentColumn: "reminder_24h_sent_at" | "reminder_2h_sent_at";
  attemptsColumn: "reminder_24h_send_attempts" | "reminder_2h_send_attempts";
}): Promise<Joined[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "*, service:services(name, default_duration_minutes, pre_care_instructions), studio:studios(*), client:clients(name, email), practitioner:practitioners(display_name, email)",
    )
    .eq("status", "confirmed")
    .is(opts.notSentColumn, null)
    .lt(opts.attemptsColumn, MAX_ATTEMPTS)
    .gte("starts_at", opts.startIso)
    .lte("starts_at", opts.endIso)
    .order("starts_at", { ascending: true })
    .limit(PER_RUN_LIMIT);
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as Array<
    Appointment & {
      service: Joined["service"] | Joined["service"][] | null;
      studio: Studio | Studio[] | null;
      client: Joined["client"] | Joined["client"][] | null;
      practitioner: Joined["practitioner"] | Joined["practitioner"][] | null;
    }
  >).map((row) => ({
    ...(row as Appointment),
    service: pickRel(row.service),
    studio: pickRel(row.studio),
    client: pickRel(row.client),
    practitioner: pickRel(row.practitioner),
  }));
}

type RunStats = { attempted: number; succeeded: number; failed: number };

async function sendReminderPass(opts: {
  kind: "24h" | "2h";
  windowStartIso: string;
  windowEndIso: string;
}): Promise<RunStats> {
  const sentColumn =
    opts.kind === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at";
  const attemptsColumn =
    opts.kind === "24h"
      ? "reminder_24h_send_attempts"
      : "reminder_2h_send_attempts";
  const studioToggle =
    opts.kind === "24h" ? "send_24h_reminders" : "send_2h_reminders";

  const appts = await loadAppointmentsForWindow({
    startIso: opts.windowStartIso,
    endIso: opts.windowEndIso,
    notSentColumn: sentColumn,
    attemptsColumn,
  });

  const admin = createAdminClient();
  const stats: RunStats = { attempted: 0, succeeded: 0, failed: 0 };

  for (const appt of appts) {
    if (!appt.studio) continue;
    // Studio-level toggle.
    if (!(appt.studio as unknown as Record<string, boolean>)[studioToggle]) {
      continue;
    }
    if (!appt.client?.email) continue;

    stats.attempted += 1;
    const token = appt.cancellation_token;
    if (!token) {
      // Without a token there's no cancel/reschedule URL; skip and mark
      // as attempted so we don't loop forever on rows that pre-date the
      // backfill or hit an insert race.
      await admin
        .from("appointments")
        .update({
          [attemptsColumn]: (appt[attemptsColumn] as number) + 1,
        })
        .eq("id", appt.id);
      stats.failed += 1;
      continue;
    }
    const cancellationUrl = `${APP_ORIGIN}/cancel/${token}`;
    const rescheduleUrl = `${APP_ORIGIN}/reschedule/${token}`;
    const practitionerName =
      appt.practitioner?.display_name?.trim() ||
      appt.practitioner?.email ||
      null;

    try {
      const treatmentTimeLine = appt.studio.show_treatment_time_to_clients
        ? buildTreatmentTimeLine({
            enabled: true,
            clientFirstName:
              appt.client.name.split(/\s+/)[0] || appt.client.name,
            context: await getTreatmentTimeContextForEmail(
              appt.studio.id,
              appt.client_id,
            ),
          })
        : null;
      const sendFn =
        opts.kind === "24h" ? send24hReminderToClient : send2hReminderToClient;
      await sendFn({
        appointment: appt,
        service: appt.service,
        studio: appt.studio,
        practitionerDisplayName: practitionerName,
        clientName: appt.client.name,
        clientEmail: appt.client.email,
        cancellationUrl,
        rescheduleUrl,
        treatmentTimeLine,
      });
      await admin
        .from("appointments")
        .update({
          [sentColumn]: new Date().toISOString(),
          [attemptsColumn]: (appt[attemptsColumn] as number) + 1,
        })
        .eq("id", appt.id);
      stats.succeeded += 1;
    } catch (err) {
      console.error(`Reminder ${opts.kind} send failed for ${appt.id}:`, err);
      await admin
        .from("appointments")
        .update({
          [attemptsColumn]: (appt[attemptsColumn] as number) + 1,
        })
        .eq("id", appt.id);
      stats.failed += 1;
    }
  }

  return stats;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  // 24h pass: appointments starting in 23-25h from now.
  const win24Start = new Date(now + 23 * 60 * 60 * 1000).toISOString();
  const win24End = new Date(now + 25 * 60 * 60 * 1000).toISOString();
  // 2h pass: 1h45m to 2h15m.
  const win2Start = new Date(now + 105 * 60 * 1000).toISOString();
  const win2End = new Date(now + 135 * 60 * 1000).toISOString();

  const reminder_24h = await sendReminderPass({
    kind: "24h",
    windowStartIso: win24Start,
    windowEndIso: win24End,
  });
  const reminder_2h = await sendReminderPass({
    kind: "2h",
    windowStartIso: win2Start,
    windowEndIso: win2End,
  });

  return NextResponse.json({ ok: true, reminder_24h, reminder_2h });
}
