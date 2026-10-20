import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isAdmin } from "@/lib/admin";
import { describeLeadAlert, type LeadAlertSummary, type PlatformLeadKind } from "@/lib/platform-leads/alert-status";

// ===========================================================================
// LEAD-ALERT-01 (#826): ONE Hone lead, as the operator alert links to it
// (Codex P2 4248920469: /admin lists only the latest 20 leads of each kind).
// ===========================================================================
//
// PLATFORM LEADS ONLY. A lead is a prospective STUDIO (a demo request or an
// early-access signup), never a client: this page reads demo_requests or
// waitlist and that lead's alert status, and nothing else -- no studio, client,
// appointment, chart or treatment table, and never the alert's frozen message.
// It is pinned by tests/app/admin/lead-detail-page.test.ts.
//
// ADMIN ONLY. The /admin layout already refuses a non-admin; this page checks
// again before reading anything, and answers 404 (not "forbidden") so it does
// not confirm that a lead exists. An unknown kind or a malformed id is the
// same 404.
// ===========================================================================

// The inverse of leadDetailPath's segment.
const KINDS: Record<string, PlatformLeadKind> = {
  "demo-request": "demo_request",
  "early-access": "early_access",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DemoLead = {
  id: string;
  name: string;
  email: string;
  practice_name: string | null;
  location: string | null;
  practice_type: string | null;
  practitioner_count: string | null;
  current_tool: string | null;
  notes: string | null;
  status: string | null;
  created_at: string;
};
type EarlyAccessLead = { id: string; email: string; practice_name: string | null; created_at: string };

export default async function LeadDetailPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || !isAdmin(user.email)) notFound();

  const { kind: kindSegment, id } = await params;
  const kind = KINDS[kindSegment];
  if (!kind || !UUID.test(id)) notFound();

  const admin = createAdminClient();
  const lead =
    kind === "demo_request"
      ? await admin
          .from("demo_requests")
          .select("id, name, email, practice_name, location, practice_type, practitioner_count, current_tool, notes, status, created_at")
          .eq("id", id)
          .maybeSingle()
      : await admin.from("waitlist").select("id, email, practice_name, created_at").eq("id", id).maybeSingle();
  if (lead.error) throw new Error("The lead could not be loaded.");
  if (!lead.data) notFound();

  const alert = await admin
    .from("platform_lead_alerts")
    .select("status, attempt_count, last_error_code")
    .eq(kind === "demo_request" ? "demo_request_id" : "waitlist_id", id)
    .maybeSingle();
  const badge = alert.error ? null : describeLeadAlert((alert.data as LeadAlertSummary | null) ?? null);

  const rows: Array<[string, string | null]> =
    kind === "demo_request"
      ? (() => {
          const d = lead.data as DemoLead;
          return [
            ["Name", d.name],
            ["Email", d.email],
            ["Practice", d.practice_name],
            ["City", d.location],
            ["Practice type", d.practice_type],
            ["Practitioners", d.practitioner_count],
            ["Current tool", d.current_tool],
            ["Status", d.status],
            ["Received", d.created_at],
          ];
        })()
      : (() => {
          const w = lead.data as EarlyAccessLead;
          return [
            ["Email", w.email],
            ["Practice", w.practice_name],
            ["Received", w.created_at],
          ];
        })();
  const notes = kind === "demo_request" ? (lead.data as DemoLead).notes : null;

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 md:px-8" data-testid="admin-lead-detail" data-kind={kind}>
      <p className="mb-4 text-sm">
        <Link href="/admin" className="underline">
          Back to the console
        </Link>
      </p>
      <h1 className="mb-6 text-2xl font-medium">{kind === "demo_request" ? "Demo request" : "Early-access signup"}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-neutral-500">{label}</dt>
            <dd>{value ?? "Not given"}</dd>
          </div>
        ))}
      </dl>
      {kind === "demo_request" ? (
        <section className="mt-6">
          <h2 className="mb-2 text-lg font-medium">Notes</h2>
          <p className="whitespace-pre-wrap text-sm" data-testid="admin-lead-notes">
            {notes && notes.trim().length > 0 ? notes : "No notes."}
          </p>
        </section>
      ) : null}
      <section className="mt-6 text-sm" data-testid="admin-lead-alert">
        <h2 className="mb-2 text-lg font-medium">Operator alert</h2>
        {badge ? (
          <p>
            {badge.label}
            {badge.detail ? ` — ${badge.detail}` : ""}
          </p>
        ) : (
          <p className="text-red-700">The alert status could not be loaded.</p>
        )}
      </section>
    </div>
  );
}
