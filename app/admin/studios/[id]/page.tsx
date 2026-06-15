import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { FormattedDateTime } from "@/components/formatted-date-time";

// PR #256: admin studio-detail privacy follow-up. Operator-only (the /admin
// layout's isAdmin gate covers this page). Shows operational metadata +
// AGGREGATE counts + setup-health flags ONLY. It deliberately does NOT select
// or render raw client names/contacts, treatment notes, imported-memory
// contents, exposure incidents, payment internals, Stripe ids, tokens, or
// audit JSON — clients/appointments/imported memory appear as counts only.

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
};

async function loadStudioDetail(id: string): Promise<StudioDetail | null> {
  const admin = createAdminClient();

  const [studioRes, invitesRes] = await Promise.all([
    // Explicit columns + aggregate count embeds only (no row contents). Every
    // embedded table (practitioners/clients/services/studio_availability_default/
    // appointments/imported_treatment_memories) has a studio_id FK to studios.
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

  return {
    id: s.id,
    name: s.name,
    slug: s.slug,
    timezone: s.timezone,
    owner_email: s.owner_email,
    created_at: s.created_at,
    practitioner_count: s.practitioners?.[0]?.count ?? 0,
    client_count: s.clients?.[0]?.count ?? 0,
    service_count: s.services?.[0]?.count ?? 0,
    availability_count: s.studio_availability_default?.[0]?.count ?? 0,
    appointment_count: s.appointments?.[0]?.count ?? 0,
    imported_memory_count: s.imported_treatment_memories?.[0]?.count ?? 0,
    owner_invite_status: ownerInviteStatus,
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
          Aggregate counts only — no client names, contact details, or clinical
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
          <Flag ok label="Live payments disabled" />
        </div>
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
