import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  loadStudioPaymentStatus,
  type StudioModeRow,
} from "@/lib/payments/admin-payment-status";
import { AdminModeBadge } from "@/app/admin/mode-badge";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { ResendWelcomeButton } from "./ResendWelcomeButton";

// PR #256: admin studio-detail privacy follow-up. Operator-only (the /admin
// layout's isAdmin gate covers this page). Shows operational metadata +
// AGGREGATE counts + setup-health flags ONLY. It deliberately does NOT select
// or render raw client names/contacts, treatment notes, imported-memory
// contents, exposure incidents, payment internals, Stripe ids, tokens, or
// audit JSON: clients/appointments/imported memory appear as counts only.

type OwnerInviteStatus = "accepted" | "pending" | "none";

type StudioDetail = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  owner_email: string;
  created_at: string;
  practitioner_count: number;
  client_count: number;
  service_count: number;
  availability_count: number;
  appointment_count: number;
  imported_memory_count: number;
  owner_invite_status: OwnerInviteStatus;
  onboarding: OnboardingAdminView;
};

// Onboarding-v2 status for the admin view (migration 0140). Send outcome only
// (Sent / Failed / not sent), no delivered/opened tracking. requiredDone is a
// coarse progress derived from the aggregate counts already loaded here.
type OnboardingAdminView = {
  enabled: boolean;
  status: string;
  welcomeEmailStatus: "not_sent" | "sending" | "sent" | "failed";
  welcomeEmailLastSentAt: string | null;
  completedAt: string | null;
  dismissedAt: string | null;
  requiredDone: number;
  requiredTotal: number;
};

async function loadStudioDetail(id: string): Promise<StudioDetail | null> {
  const admin = createAdminClient();

  const [studioRes, invitesRes, onboardingRes, flagRes] = await Promise.all([
    // Explicit columns + aggregate count embeds only (no row contents). Every
    // embedded table (practitioners/clients/services/studio_availability_default/
    // appointments/imported_treatment_memories) has a studio_id FK to studios.
    // The onboarding-v2 flag + state are read SEPARATELY (below) so that a
    // deployment where migration 0140 is not yet applied (or was rolled back)
    // never breaks this core page: the onboarding section degrades to "off".
    admin
      .from("studios")
      .select(
        "id, name, slug, timezone, owner_email, created_at, practitioners(count), clients(count), services(count), studio_availability_default(count), appointments(count), imported_treatment_memories(count)",
      )
      .eq("id", id)
      .maybeSingle(),
    admin
      .from("pending_invitations")
      .select("status")
      .eq("studio_id", id)
      .eq("role", "owner"),
    // Skew-tolerant: a missing studio_onboarding table returns an error in the
    // result (not a throw), so `ob` falls back to null -> "not started".
    admin
      .from("studio_onboarding")
      .select(
        "status, welcome_email_status, welcome_email_last_sent_at, completed_at, dismissed_at",
      )
      .eq("studio_id", id)
      .maybeSingle(),
    // Skew-tolerant: a missing onboarding_v2_enabled column returns an error in
    // the result; we default the flag to false rather than throwing.
    admin
      .from("studios")
      .select("onboarding_v2_enabled")
      .eq("id", id)
      .maybeSingle(),
  ]);

  if (studioRes.error) throw new Error(studioRes.error.message);
  if (invitesRes.error) throw new Error(invitesRes.error.message);
  if (!studioRes.data) return null;

  type StudioRaw = {
    id: string;
    name: string;
    slug: string | null;
    timezone: string;
    owner_email: string;
    created_at: string;
    practitioners: { count: number }[] | null;
    clients: { count: number }[] | null;
    services: { count: number }[] | null;
    studio_availability_default: { count: number }[] | null;
    appointments: { count: number }[] | null;
    imported_treatment_memories: { count: number }[] | null;
  };
  const s = studioRes.data as StudioRaw;

  const inviteStatuses = ((invitesRes.data ?? []) as { status: string }[]).map(
    (i) => i.status,
  );
  const ownerInviteStatus: OwnerInviteStatus = inviteStatuses.includes(
    "accepted",
  )
    ? "accepted"
    : inviteStatuses.includes("pending")
      ? "pending"
      : "none";

  const serviceCount = s.services?.[0]?.count ?? 0;
  const availabilityCount = s.studio_availability_default?.[0]?.count ?? 0;
  // Coarse required-setup progress (service / availability / booking-page), the
  // same three signals that gate a studio being bookable.
  const requiredDone =
    (serviceCount > 0 ? 1 : 0) +
    (availabilityCount > 0 ? 1 : 0) +
    (s.slug && serviceCount > 0 ? 1 : 0);

  const ob = (onboardingRes.data ?? null) as {
    status: string;
    welcome_email_status: "not_sent" | "sending" | "sent" | "failed";
    welcome_email_last_sent_at: string | null;
    completed_at: string | null;
    dismissed_at: string | null;
  } | null;

  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    timezone: s.timezone,
    owner_email: s.owner_email,
    created_at: s.created_at,
    practitioner_count: s.practitioners?.[0]?.count ?? 0,
    client_count: s.clients?.[0]?.count ?? 0,
    service_count: serviceCount,
    availability_count: availabilityCount,
    appointment_count: s.appointments?.[0]?.count ?? 0,
    imported_memory_count: s.imported_treatment_memories?.[0]?.count ?? 0,
    owner_invite_status: ownerInviteStatus,
    onboarding: {
      enabled:
        (flagRes.data as { onboarding_v2_enabled?: boolean } | null)
          ?.onboarding_v2_enabled === true,
      status: ob?.status ?? "not_started",
      welcomeEmailStatus: ob?.welcome_email_status ?? "not_sent",
      welcomeEmailLastSentAt: ob?.welcome_email_last_sent_at ?? null,
      completedAt: ob?.completed_at ?? null,
      dismissedAt: ob?.dismissed_at ?? null,
      requiredDone,
      requiredTotal: 3,
    },
  };
}

export default async function AdminStudioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const studio = await loadStudioDetail(id);
  if (!studio) notFound();
  // PR B: per-studio payment status: capability/status/counts only, both
  // modes, redacted account suffix. Read via the shared admin helper.
  const payments = await loadStudioPaymentStatus(createAdminClient(), id);

  const inviteLabel =
    studio.owner_invite_status === "accepted"
      ? "Accepted"
      : studio.owner_invite_status === "pending"
        ? "Pending"
        : "None";

  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <header>
        <Link
          href="/admin"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Admin
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          {studio.name}
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          {studio.owner_email}
          {" · created "}
          <FormattedDateTime iso={studio.created_at} />
        </p>
      </header>

      <section className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800 sm:grid-cols-2">
        <Row label="Booking">
          {studio.slug ? (
            <Link href={`/book/${studio.slug}`} className="font-mono underline">
              /book/{studio.slug}
            </Link>
          ) : (
            <span className="text-neutral-400">—</span>
          )}
        </Row>
        <Row label="Timezone">{studio.timezone}</Row>
        <Row label="Owner email">{studio.owner_email}</Row>
        <Row label="Owner invite">{inviteLabel}</Row>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-medium">Counts</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          <Stat label="Practitioners" value={studio.practitioner_count} />
          <Stat label="Clients" value={studio.client_count} />
          <Stat label="Services" value={studio.service_count} />
          <Stat label="Appointments" value={studio.appointment_count} />
          <Stat label="Imported memory" value={studio.imported_memory_count} />
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Aggregate counts only, no client names, contact details, or clinical
          content are shown here.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-medium">Setup checks</h2>
        <div className="flex flex-wrap gap-2">
          <Flag ok={studio.practitioner_count > 0} label="Owner active" />
          <Flag ok={studio.service_count > 0} label="Services configured" />
          <Flag
            ok={studio.availability_count > 0}
            label="Availability configured"
          />
          <Flag ok={Boolean(studio.slug)} label="Booking slug set" />
          <Flag
            ok={
              (payments.runtimeMode === "live"
                ? payments.live.capability
                : payments.test.capability) === "ready"
            }
            label={`Payments (${payments.runtimeMode} mode): ${
              payments.runtimeMode === "live"
                ? payments.live.capability
                : payments.test.capability
            }`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-medium">Onboarding</h2>
        <div className="grid grid-cols-1 gap-3 rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800 sm:grid-cols-2">
          <Row label="Guided onboarding">
            {studio.onboarding.enabled ? (
              "Enabled"
            ) : (
              <span className="text-neutral-400">Off</span>
            )}
          </Row>
          <Row label="Owner invite">{inviteLabel}</Row>
          <Row label="Progress">
            {studio.onboarding.status === "completed" ? (
              <span className="text-emerald-600 dark:text-emerald-400">
                Complete
              </span>
            ) : (
              `${studio.onboarding.requiredDone} / ${studio.onboarding.requiredTotal} required steps`
            )}
          </Row>
          <Row label="Welcome email">
            {studio.onboarding.welcomeEmailStatus === "sent" ? (
              <span>
                Sent
                {studio.onboarding.welcomeEmailLastSentAt ? (
                  <>
                    {" · "}
                    <FormattedDateTime
                      iso={studio.onboarding.welcomeEmailLastSentAt}
                    />
                  </>
                ) : null}
              </span>
            ) : studio.onboarding.welcomeEmailStatus === "sending" ? (
              <span className="text-neutral-500">Sending…</span>
            ) : studio.onboarding.welcomeEmailStatus === "failed" ? (
              <span className="text-amber-700 dark:text-amber-300">Failed</span>
            ) : (
              <span className="text-neutral-400">Not sent</span>
            )}
          </Row>
        </div>
        <div className="mt-3">
          <ResendWelcomeButton studioId={studio.id} />
        </div>
        <p className="mt-2 text-xs text-neutral-500">
          Sends the owner welcome email again and re-records the outcome.
          Delivery/opened status is not tracked.
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-xl font-medium">Payments</h2>
        <p className="mb-3 max-w-prose text-sm text-neutral-500">
          Runtime: {payments.runtimeMode} mode. Capability, status, and
          mode-separated counts only: account ids are redacted; no payment,
          card, or customer identifiers are shown.
        </p>
        {payments.loadError ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            Payment status could not be loaded. Check ops alerts before
            assuming this studio is healthy.
          </p>
        ) : (
          <div className="flex flex-wrap gap-4">
            <PaymentModeCard label="Live" row={payments.live} />
            <PaymentModeCard label="Test" row={payments.test} />
          </div>
        )}
      </section>

      <section className="flex flex-wrap gap-4 text-sm">
        <Link href="/admin" className="underline">
          Admin Console
        </Link>
        <Link href="/admin/studios/new" className="underline">
          Create new studio
        </Link>
      </section>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="text-right font-medium">{children}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-neutral-500">{label}</div>
    </div>
  );
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${
        ok
          ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
          : "bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400"
      }`}
    >
      <span aria-hidden="true">{ok ? "✓" : "—"}</span>
      {label}
    </span>
  );
}

// PR B: one mode's payment posture. Redaction-first, the helper only ever
// returns capability/status/counts plus a redacted account suffix.
function PaymentModeCard({ label, row }: { label: "Live" | "Test"; row: StudioModeRow }) {
  return (
    <div className="min-w-[240px] rounded-lg border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-medium">{label} row</span>
        <AdminModeBadge livemode={label === "Live"} />
      </div>
      {row.exists ? (
        <dl className="flex flex-col gap-1">
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Capability</dt>
            <dd className="font-medium">{row.capability}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Account status</dt>
            <dd>{row.accountStatus ?? "-"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Charges enabled</dt>
            <dd>{row.chargesEnabled ? "yes" : "no"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Payouts enabled</dt>
            <dd>{row.payoutsEnabled ? "yes" : "no"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Account</dt>
            <dd className="font-mono">{row.accountIdRedacted ?? "-"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Active cards</dt>
            <dd>{row.activeCards}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-neutral-500">Attempts</dt>
            <dd>
              {row.attempts.succeeded} succeeded · {row.attempts.active} active ·{" "}
              {row.attempts.other} other
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-neutral-500">No {label.toLowerCase()}-mode row, not connected in this mode.</p>
      )}
    </div>
  );
}
