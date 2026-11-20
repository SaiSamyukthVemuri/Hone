import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { OverInviteForm } from "@/components/waitlist/over-invite-form";
import { OverInviteBatches, type OpenBatch } from "@/components/waitlist/over-invite-batches";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { addDays, localDateString } from "@/lib/booking/tz";
import { computeConsultationFit } from "@/lib/waitlist/send-time-fit";
import { newBatchKey } from "@/lib/waitlist/over-invite-selection";
import { previewSelection } from "@/lib/waitlist/over-invite-port";
import type { Candidate } from "@/lib/waitlist/recipient-chooser";
import { continueOverInviteAction, retryOverInviteDeliveriesAction, sendOverInviteAction } from "./actions";

// Owner-only. NAMES ONLY go to the browser (no email, phone or token), and nothing on this page logs a name. The numbers are the server's: the fit
// from the slot engine and the live count from the same database function the batch command re-checks under its lock.

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_PAGE = 1000;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function waitingNames(studioId: string): Promise<Candidate[] | null> {
  const supabase = await createClient();
  const out: Candidate[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await supabase
      .from("new_client_waitlist_entries")
      .select("id,name")
      .eq("studio_id", studioId)
      .eq("status", "waiting")
      .order("joined_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return null;
    for (const r of data ?? []) out.push({ entryId: String(r.id), name: typeof r.name === "string" && r.name ? r.name : "Unnamed" });
    if (!data || data.length < READ_PAGE) return out;
  }
}

/** This studio's confirmed batches that still have people to send, read through the owner's own session (owner-only select policy). */
async function openBatches(studioId: string): Promise<OpenBatch[]> {
  const supabase = await createClient();
  const { data: items, error } = await supabase
    .from("waitlist_invitation_batch_items")
    .select("batch_id,state")
    .eq("studio_id", studioId)
    .in("state", ["pending", "claimed"]);
  if (error || !items || items.length === 0) return [];
  const remaining = new Map<string, number>();
  for (const i of items) remaining.set(String(i.batch_id), (remaining.get(String(i.batch_id)) ?? 0) + 1);
  const { data: batches, error: bErr } = await supabase
    .from("waitlist_invitation_batches")
    .select("id,confirmed_at,quantity,fit_shown,live_shown")
    .eq("studio_id", studioId)
    .in("id", [...remaining.keys()])
    .order("confirmed_at", { ascending: true });
  if (bErr || !batches) return [];
  return batches.map((b) => ({
    id: String(b.id),
    confirmedAt: String(b.confirmed_at),
    quantity: Number(b.quantity),
    fitShown: Number(b.fit_shown),
    liveShown: Number(b.live_shown),
    remaining: remaining.get(String(b.id)) ?? 0,
  }));
}

export default async function OverInvitePage({
  searchParams,
}: {
  searchParams?: Promise<{ service?: string | string[]; days?: string | string[]; weekdays?: string | string[] }>;
}) {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.user_id) {
    return <OwnerOnlyNotice>Only studio owners can invite beyond the estimate.</OwnerOnlyNotice>;
  }
  const params = (await searchParams) ?? {};
  const open = await openBatches(studio.id);
  const batchesPanel = <OverInviteBatches batches={open} continueAction={continueOverInviteAction} renderedAt={Date.now()} />;
  const supabase = await createClient();
  const { data: services } = await supabase.from("services").select("id,name,active").eq("studio_id", studio.id).order("name");
  const list = (services ?? []).filter((s) => s.active !== false);
  const serviceId = first(params.service);
  const daysRaw = first(params.days) ?? "7";
  const weekdaysRaw = first(params.weekdays) ?? "";
  const days = /^\d{1,3}$/.test(daysRaw) ? Number(daysRaw) : 7;
  const weekdays = weekdaysRaw && /^[0-6](,[0-6])*$/.test(weekdaysRaw) ? [...new Set(weekdaysRaw.split(",").map(Number))].sort() : null;
  const chosenService = serviceId && UUID.test(serviceId) ? list.find((s) => s.id === serviceId) : undefined;

  const chooser = (
    <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex flex-col gap-1">
        Service
        <select name="service" defaultValue={chosenService?.id ?? ""} className="min-h-11 rounded-md border px-2">
          <option value="" disabled>
            Choose a service
          </option>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        Days offered
        <input name="days" type="number" min={1} max={365} defaultValue={days} className="min-h-11 w-24 rounded-md border px-2" />
      </label>
      <button type="submit" className="min-h-11 rounded-md border px-3">
        Show numbers
      </button>
    </form>
  );

  if (!chosenService || days < 1 || days > 365) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <h1 className="text-xl font-semibold">Invite beyond the estimate</h1>
        {batchesPanel}
        {chooser}
      </main>
    );
  }

  const start = localDateString(new Date(), studio.timezone ?? "UTC");
  const end = addDays(start, days - 1);
  const admin = createAdminClient();
  const [fit, live, names] = await Promise.all([
    computeConsultationFit({ admin, studioId: studio.id, serviceId: chosenService.id, windowDays: days, allowedWeekdays: weekdays }),
    previewSelection(admin, { studioId: studio.id, actorUserId: practitioner.user_id, entryIds: [], startDate: start, endDate: end, allowedWeekdays: weekdays }),
    waitingNames(studio.id),
  ]);
  if (!fit.ok || !live.ok || live.result !== "ok" || names === null) {
    return (
      <main className="flex flex-col gap-4 p-4">
        <h1 className="text-xl font-semibold">Invite beyond the estimate</h1>
        {chooser}
        <p role="alert">We couldn&apos;t load the numbers just now. Nothing was sent. Please try again.</p>
      </main>
    );
  }
  return (
    <main className="flex flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">Invite beyond the estimate</h1>
      {batchesPanel}
      {chooser}
      <OverInviteForm
        action={sendOverInviteAction}
        retryAction={retryOverInviteDeliveriesAction}
        continueAction={continueOverInviteAction}
        candidates={names}
        fit={fit.fit}
        active={live.liveCount}
        expiringSoon={live.expiringWithin24h}
        batchKey={newBatchKey()}
        scope={{ serviceId: chosenService.id, windowDays: days, allowedWeekdays: weekdays }}
      />
    </main>
  );
}
