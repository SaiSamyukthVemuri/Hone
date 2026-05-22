import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  logEmailFailure,
  recordEmailAttempt,
  sendNoShowFollowupToClient,
} from "@/lib/email/send-appointment";
import type { Appointment, Studio } from "@/lib/types/database";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const PER_RUN_LIMIT = 100;

function pickRel<T>(v: T | T[] | null): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const now = Date.now();
  const cutoff = new Date(now - 30 * 60 * 1000).toISOString(); // 30 min ago
  const lookback = new Date(now - 24 * 60 * 60 * 1000).toISOString(); // 24h ago

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("appointments")
    .select(
      "*, studio:studios(*), client:clients(name, email)",
    )
    .eq("status", "confirmed")
    .gte("starts_at", lookback)
    .lt("starts_at", cutoff)
    .order("starts_at", { ascending: true })
    .limit(PER_RUN_LIMIT);
  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }

  type Joined = Appointment & {
    studio: Studio | Studio[] | null;
    client: { name: string; email: string | null } | { name: string; email: string | null }[] | null;
  };

  const rows = ((data ?? []) as unknown as Joined[]).map((r) => ({
    ...(r as Appointment),
    studio: pickRel(r.studio),
    client: pickRel(r.client),
  }));

  const stats = { scanned: rows.length, marked: 0, followups_sent: 0 };

  for (const appt of rows) {
    if (!appt.studio) continue;
    if (!appt.studio.auto_mark_no_shows) continue;

    const { error: updateErr } = await admin
      .from("appointments")
      .update({
        status: "no_show",
        updated_at: new Date().toISOString(),
      })
      .eq("id", appt.id)
      .eq("status", "confirmed");
    if (updateErr) {
      console.error(`No-show update failed for ${appt.id}:`, updateErr);
      continue;
    }
    stats.marked += 1;

    if (appt.studio.send_no_show_followup && appt.client?.email) {
      // Cron query intentionally untouched per the email-truthful refactor
      // spec. recordEmailAttempt stamps no_show_email_sent_at only when
      // the send actually succeeded, and increments
      // no_show_email_send_attempts atomically in both branches.
      const attemptNumber = appt.no_show_email_send_attempts + 1;
      const result = await sendNoShowFollowupToClient({
        clientName: appt.client.name,
        clientEmail: appt.client.email,
        studio: appt.studio,
        rebookUrl: appt.studio.slug
          ? `${APP_ORIGIN}/book/${appt.studio.slug}`
          : null,
      });
      await recordEmailAttempt(admin, appt.id, "no_show", result.ok);
      if (result.ok) {
        stats.followups_sent += 1;
      } else {
        logEmailFailure({
          appointmentId: appt.id,
          emailType: "no_show",
          error: result.error,
          retryable: result.retryable,
          attemptNumber,
        });
      }
    }
  }

  return NextResponse.json({ ok: true, ...stats });
}
