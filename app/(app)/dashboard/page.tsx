import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
  getPractitionersForStudio,
} from "@/lib/supabase/queries";
import { getActiveServices } from "@/lib/booking/queries";
import { getLatestPinnedNoteByClient } from "@/lib/client-pinned-notes/queries";
import {
  addDays,
  localTimeString,
  todayInTz,
  utcInstantFromLocal,
} from "@/lib/booking/tz";
import { ClientSearch } from "@/components/client-search";
import { FormattedToday } from "@/components/formatted-date-time";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import type {
  Appointment,
  AppointmentStatus,
  Client,
  ClientIntakeForm,
  Service,
} from "@/lib/types/database";
import { DashboardGreeting } from "./DashboardGreeting";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

type TodayAppointment = Pick<
  Appointment,
  | "id"
  | "starts_at"
  | "ends_at"
  | "duration_minutes"
  | "status"
  | "client_id"
> & {
  client: Pick<Client, "id" | "name" | "allergies" | "pronouns"> | null;
  service: Pick<Service, "id" | "name" | "modality"> | null;
  practitioner: { id: string; display_name: string | null; color: string } | null;
};

export default async function DashboardPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const isOwner = practitioner.role === "owner";
  const supabase = await createClient();

  // Studio-local "today" range, converted to UTC for the appointments
  // query. The calendar week view uses the same pattern; we just window
  // it to a single local day here.
  const todayLocal = todayInTz(studio.timezone);
  const tomorrowLocal = addDays(todayLocal, 1);
  const startUtc = utcInstantFromLocal(todayLocal, "00:00", studio.timezone);
  const endUtc = utcInstantFromLocal(tomorrowLocal, "00:00", studio.timezone);

  // Today's appointments. Use a narrow inline SELECT so the dashboard
  // gets practitioner color + service modality + client allergies in
  // one trip without N+1 lookups.
  const { data: apptRows, error: apptErr } = await supabase
    .from("appointments")
    .select(
      "id, starts_at, ends_at, duration_minutes, status, client_id, client:clients(id, name, allergies, pronouns), service:services(id, name, modality), practitioner:practitioners(id, display_name, color)",
    )
    .eq("studio_id", studio.id)
    .gte("starts_at", startUtc.toISOString())
    .lt("starts_at", endUtc.toISOString())
    .order("starts_at", { ascending: true });
  if (apptErr) {
    throw new Error(`Failed to load today's appointments: ${apptErr.message}`);
  }

  // Supabase types joined relations as either a single row or an array.
  // Normalize so the renderer can do `a.practitioner?.color` without
  // branching, same idiom as getAppointmentsForRange.
  type RawAppt = {
    id: string;
    starts_at: string;
    ends_at: string;
    duration_minutes: number;
    status: AppointmentStatus;
    client_id: string;
    client:
      | Pick<Client, "id" | "name" | "allergies" | "pronouns">
      | Pick<Client, "id" | "name" | "allergies" | "pronouns">[]
      | null;
    service:
      | Pick<Service, "id" | "name" | "modality">
      | Pick<Service, "id" | "name" | "modality">[]
      | null;
    practitioner:
      | { id: string; display_name: string | null; color: string }
      | { id: string; display_name: string | null; color: string }[]
      | null;
  };
  const todayAppointments: TodayAppointment[] = (
    (apptRows ?? []) as RawAppt[]
  ).map((r) => ({
    id: r.id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    duration_minutes: r.duration_minutes,
    status: r.status,
    client_id: r.client_id,
    client: Array.isArray(r.client) ? r.client[0] ?? null : r.client,
    service: Array.isArray(r.service) ? r.service[0] ?? null : r.service,
    practitioner: Array.isArray(r.practitioner)
      ? r.practitioner[0] ?? null
      : r.practitioner,
  }));

  // The visible roster excludes cancelled appointments — they shouldn't
  // crowd a "what's today" briefing. Cancellation records remain on the
  // calendar week view, where context is appropriate.
  const visibleAppointments = todayAppointments.filter(
    (a) => a.status !== "cancelled",
  );

  const todayClientIds = Array.from(
    new Set(visibleAppointments.map((a) => a.client_id)),
  );

  // Bulk lookups for the visible client set. Each query is read-only,
  // RLS-scoped, and bounded by today's client list.
  const [clients, practitioners, pinnedByClient, intakeByClient] =
    await Promise.all([
      getClientsForStudio(studio.id),
      getPractitionersForStudio(studio.id),
      getLatestPinnedNoteByClient(studio.id, todayClientIds),
      loadIntakeStatusByClient(supabase, studio.id, todayClientIds),
    ]);
  void practitioners; // currently unused on the appointments roster;
  // kept fetched in parallel because future per-practitioner annotations
  // may surface here without paying an extra round-trip.

  // "Needs attention" sources. Each is independently safe to fail; if a
  // single signal can't be fetched we render the rest. All checks here
  // are bounded SELECTs on tables we already have RLS on.
  const [
    intakesAwaitingReviewCount,
    activeServicesCount,
    paymentStatus,
  ] = await Promise.all([
    countIntakesAwaitingReview(supabase, studio.id),
    countActiveServices(studio.id),
    isOwner ? loadPaymentStatus(supabase, studio.id) : Promise.resolve(null),
  ]);

  const bookingUrl = `${APP_ORIGIN.replace(/\/$/, "")}/book/${studio.slug}`;

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-1">
        <DashboardGreeting displayName={practitioner.display_name} />
        <p className="text-xs uppercase tracking-wider text-neutral-500">
          <FormattedToday format="weekday-date" />
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
        <DaySummary
          appointmentCount={visibleAppointments.length}
          clientCount={todayClientIds.length}
        />
      </section>

      <NeedsAttention
        isOwner={isOwner}
        intakesAwaitingReviewCount={intakesAwaitingReviewCount}
        activeServicesCount={activeServicesCount}
        paymentStatus={paymentStatus}
      />

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Appointments</h2>
          <Link
            href="/clients/new"
            className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Add client
          </Link>
        </div>

        {visibleAppointments.length === 0 ? (
          <EmptyDayState
            bookingUrl={bookingUrl}
            hasServices={activeServicesCount > 0}
          />
        ) : (
          <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {visibleAppointments.map((appt) => (
              <li key={appt.id}>
                <AppointmentRow
                  appt={appt}
                  pinnedNoteText={
                    pinnedByClient.get(appt.client_id)?.text ?? null
                  }
                  intakeStatus={intakeByClient.get(appt.client_id) ?? null}
                  tz={studio.timezone}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Find a client</h2>
        <ClientSearch
          clients={clients}
          excludeIds={todayClientIds}
          searchOnly
          placeholder="Find client"
          promptLabel="Type to search clients."
          emptyLabel="No clients match."
        />
      </section>

      <QuickLinks />
    </div>
  );
}

function DaySummary({
  appointmentCount,
  clientCount,
}: {
  appointmentCount: number;
  clientCount: number;
}) {
  if (appointmentCount === 0) {
    return (
      <p className="mt-1 text-sm text-neutral-500">No appointments today.</p>
    );
  }
  const appt = `${appointmentCount} ${appointmentCount === 1 ? "appointment" : "appointments"}`;
  const client = `${clientCount} ${clientCount === 1 ? "client" : "clients"}`;
  return (
    <p className="mt-1 text-sm text-neutral-500">
      {appt} · {client}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Appointment row
// ---------------------------------------------------------------------------
function AppointmentRow({
  appt,
  pinnedNoteText,
  intakeStatus,
  tz,
}: {
  appt: TodayAppointment;
  pinnedNoteText: string | null;
  intakeStatus: ClientIntakeForm["status"] | null;
  tz: string;
}) {
  const time = localTimeString(new Date(appt.starts_at), tz);
  const performerName = appt.practitioner?.display_name?.trim();
  const performerColor = resolvePractitionerColor(appt.practitioner?.color);
  const modality = appt.service?.modality
    ? appt.service.modality
    : null;
  const serviceName = appt.service?.name ?? null;
  const showAllergyFlag = !!appt.client?.allergies;

  return (
    <Link
      href={`/calendar/${appt.id}`}
      className="flex items-start justify-between gap-3 px-4 py-4 hover:bg-neutral-50 dark:hover:bg-neutral-900"
    >
      <div className="flex min-w-0 flex-1 gap-4">
        <div className="w-14 flex-none text-sm font-medium tabular-nums text-neutral-700 dark:text-neutral-300">
          {time}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate font-medium">
              {appt.client?.name ?? "Client deleted"}
            </span>
            <AppointmentStatusPill status={appt.status} />
          </div>
          <div className="mt-0.5 truncate text-xs text-neutral-500">
            {serviceName && <span>{serviceName}</span>}
            {modality && <span>{serviceName ? " · " : ""}{modality}</span>}
            <span>
              {(serviceName || modality) ? " · " : ""}
              {appt.duration_minutes} min
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {performerName ? (
              <span className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className={`inline-block h-2 w-2 rounded-full ${performerColor.bg}`}
                />
                <span className="text-neutral-600 dark:text-neutral-400">
                  {performerName}
                </span>
              </span>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">
                Unassigned
              </span>
            )}
            {showAllergyFlag && (
              <span className="inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 font-medium text-rose-900 dark:bg-rose-900/40 dark:text-rose-200">
                Allergies
              </span>
            )}
            <IntakePill status={intakeStatus} />
          </div>
          {pinnedNoteText && (
            <div
              className="mt-1 truncate text-xs text-amber-800 dark:text-amber-300"
              title={pinnedNoteText}
            >
              <span className="font-semibold uppercase tracking-wider text-[10px]">
                Pinned
              </span>{" "}
              {truncate(pinnedNoteText, 50)}
            </div>
          )}
        </div>
      </div>
      <span className="self-center text-sm text-neutral-400">›</span>
    </Link>
  );
}

function AppointmentStatusPill({ status }: { status: AppointmentStatus }) {
  if (status === "confirmed") return null;
  const variant: Record<
    "completed" | "no_show" | "cancelled",
    { label: string; classes: string }
  > = {
    completed: {
      label: "Completed",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
    no_show: {
      label: "No-show",
      classes:
        "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
    },
    cancelled: {
      label: "Cancelled",
      classes:
        "bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
    },
  };
  const v = variant[status as "completed" | "no_show" | "cancelled"];
  if (!v) return null;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${v.classes}`}
    >
      {v.label}
    </span>
  );
}

function IntakePill({
  status,
}: {
  status: ClientIntakeForm["status"] | null;
}) {
  if (!status) {
    return (
      <span className="text-neutral-400 dark:text-neutral-500">
        No intake on file
      </span>
    );
  }
  if (status === "reviewed") {
    return (
      <span className="text-emerald-700 dark:text-emerald-400">
        Intake reviewed
      </span>
    );
  }
  if (status === "submitted") {
    return (
      <span className="text-blue-700 dark:text-blue-400">
        Intake awaiting review
      </span>
    );
  }
  if (status === "in_progress") {
    return (
      <span className="text-neutral-500 dark:text-neutral-400">
        Intake in progress
      </span>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------
type PaymentStatusForDashboard = {
  hasAccount: boolean;
  livemode: boolean | null;
  onboardingCompleted: boolean;
  payoutsEnabled: boolean;
};

function NeedsAttention({
  isOwner,
  intakesAwaitingReviewCount,
  activeServicesCount,
  paymentStatus,
}: {
  isOwner: boolean;
  intakesAwaitingReviewCount: number;
  activeServicesCount: number;
  paymentStatus: PaymentStatusForDashboard | null;
}) {
  const items: Array<{
    key: string;
    title: string;
    body: string;
    href?: string;
    cta?: string;
  }> = [];

  if (intakesAwaitingReviewCount > 0) {
    items.push({
      key: "intake-review",
      title: `${intakesAwaitingReviewCount} ${
        intakesAwaitingReviewCount === 1 ? "intake" : "intakes"
      } awaiting review`,
      body: "Open the client to read the submitted answers and mark reviewed.",
      href: "/clients",
      cta: "Open clients",
    });
  }

  if (isOwner && activeServicesCount === 0) {
    items.push({
      key: "no-services",
      title: "No services yet",
      body: "Clients can't book until at least one active service exists.",
      href: "/settings/services",
      cta: "Add a service",
    });
  }

  if (isOwner && paymentStatus) {
    if (!paymentStatus.hasAccount) {
      // Soft nudge only; not flagged red. Phase 1 booking does not
      // require Stripe.
      items.push({
        key: "stripe-not-connected",
        title: "Stripe not connected yet",
        body: "Public booking still works without it. Connect when you're ready to accept payments later.",
        href: "/settings/payments",
        cta: "Open Payments",
      });
    } else if (!paymentStatus.onboardingCompleted) {
      items.push({
        key: "stripe-incomplete",
        title: "Stripe setup not finished",
        body: "A few details are still needed. Continue setup when you have a minute.",
        href: "/settings/payments",
        cta: "Continue setup",
      });
    } else if (!paymentStatus.payoutsEnabled) {
      items.push({
        key: "stripe-payouts",
        title: "Payout setup needs attention",
        body: "Stripe is connected, but payouts aren't ready yet.",
        href: "/settings/payments",
        cta: "Open Payments",
      });
    }
  }

  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Needs attention</h2>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li
            key={item.key}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900/50"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{item.title}</p>
              <p className="mt-0.5 text-xs text-neutral-600 dark:text-neutral-400">
                {item.body}
              </p>
            </div>
            {item.href && item.cta && (
              <Link
                href={item.href}
                className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                {item.cta}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Empty state + quick links
// ---------------------------------------------------------------------------
function EmptyDayState({
  bookingUrl,
  hasServices,
}: {
  bookingUrl: string;
  hasServices: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-10 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-lg font-medium">No appointments today.</p>
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        Use the quiet time to review clients, add availability, or share
        your booking link.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/calendar"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          View calendar
        </Link>
        <Link
          href="/clients/new"
          className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Add a client
        </Link>
        {hasServices && (
          <a
            href={bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-white dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Open booking page
          </a>
        )}
      </div>
    </div>
  );
}

function QuickLinks() {
  // The public booking page link used to live here and read peers
  // with Calendar / Clients / Payments. Chloe flagged that it
  // confused practitioners into clicking the client-facing booking
  // page when they meant to use the internal book-client flow on
  // the client profile. The public link is still available under
  // Settings → Booking (which renders the studio's public URL with
  // copy/share controls) and from the empty-day state above when
  // there are no appointments today.
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-medium">Quick links</h2>
      <ul className="flex flex-wrap gap-2 text-sm">
        <li>
          <Link
            href="/calendar"
            className="inline-flex rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Calendar
          </Link>
        </li>
        <li>
          <Link
            href="/clients"
            className="inline-flex rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Clients
          </Link>
        </li>
        <li>
          <Link
            href="/settings/payments"
            className="inline-flex rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Payments
          </Link>
        </li>
        <li>
          <Link
            href="/settings/booking"
            className="inline-flex rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Booking settings
          </Link>
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Read-only data helpers — kept inline because each is a narrow single-call-
// site SELECT/RPC against tables we already use elsewhere. Promoting them
// to lib/ would scatter the dashboard's "needs attention" wiring without
// reuse.
// ---------------------------------------------------------------------------
async function loadIntakeStatusByClient(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  clientIds: ReadonlyArray<string>,
): Promise<Map<string, ClientIntakeForm["status"]>> {
  const out = new Map<string, ClientIntakeForm["status"]>();
  if (clientIds.length === 0) return out;
  const { data, error } = await supabase
    .from("client_intake_forms")
    .select("client_id, status, created_at")
    .eq("studio_id", studioId)
    .in("client_id", clientIds as string[])
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to load intake status: ${error.message}`);
  }
  // First row per client_id wins (created_at desc), so each client maps
  // to the status of their most recent non-deleted intake.
  for (const row of (data ?? []) as {
    client_id: string;
    status: ClientIntakeForm["status"];
  }[]) {
    if (!out.has(row.client_id)) out.set(row.client_id, row.status);
  }
  return out;
}

async function countIntakesAwaitingReview(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from("client_intake_forms")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("status", "submitted")
    .is("deleted_at", null);
  if (error) {
    throw new Error(
      `Failed to count intakes awaiting review: ${error.message}`,
    );
  }
  return count ?? 0;
}

async function countActiveServices(studioId: string): Promise<number> {
  // Use the existing helper; cheap, already cached at the page level.
  const services = await getActiveServices(studioId);
  return services.length;
}

async function loadPaymentStatus(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
): Promise<PaymentStatusForDashboard | null> {
  // Uses the same display-safe RPC the Payments settings page reads from.
  // No Stripe SDK calls, no secrets, no Stripe IDs returned.
  const { data, error } = await supabase.rpc(
    "get_studio_payment_settings_display",
    { p_studio_id: studioId },
  );
  if (error) {
    // Surface for the page renderer's "Needs attention" branch only;
    // log the structured event but don't break the dashboard.
    console.error(
      JSON.stringify({
        event: "dashboard_payment_status_failed",
        code: error.code,
        message: error.message,
        studioId,
        timestamp: new Date().toISOString(),
      }),
    );
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      hasAccount: false,
      livemode: null,
      onboardingCompleted: false,
      payoutsEnabled: false,
    };
  }
  return {
    hasAccount: row.account_status != null && row.account_status !== "not_connected",
    livemode: typeof row.livemode === "boolean" ? row.livemode : null,
    onboardingCompleted: row.onboarding_completed_at != null,
    payoutsEnabled: row.payouts_enabled === true,
  };
}
