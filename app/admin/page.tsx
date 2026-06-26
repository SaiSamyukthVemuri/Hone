import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { FormattedDateTime } from "@/components/formatted-date-time";
import {
  readReminderHeartbeat,
  computeReminderSchedulerStatus,
  type ReminderSchedulerStatus,
} from "@/lib/cron/reminder-heartbeat";
import { markDemoContactedAction } from "./actions";

// PR #265: the reminder-scheduler status is read from the Upstash heartbeat
// (not Supabase), so it is computed outside loadConsole's Promise.all.
export const dynamic = "force-dynamic";

// PR #255: Admin Console V1. Operator-only (the /admin layout's isAdmin gate
// covers this page). Read-only operational metadata and aggregate counts over
// existing tables via the service-role client — NO client-level clinical data
// (no client names, treatment notes, exposure incidents, imported memory,
// payment internals, Stripe ids, tokens, or audit JSON is selected here).

type OwnerInviteStatus = "accepted" | "pending" | "none";

type StudioRow = {
  id: string;
  name: string;
  slug: string | null;
  timezone: string;
  owner_email: string;
  created_at: string;
  practitioner_count: number;
  client_count: number;
  services_count: number;
  availability_count: number;
  owner_invite_status: OwnerInviteStatus;
};

type PractitionerRow = {
  id: string;
  display_name: string;
  email: string;
  role: string;
  created_at: string;
  studio_name: string;
};

type WaitlistRow = {
  id: string;
  email: string;
  practice_name: string | null;
  created_at: string;
};

type DemoRequestRow = {
  id: string;
  name: string;
  email: string;
  practice_name: string | null;
  location: string | null;
  practice_type: string | null;
  practitioner_count: string | null;
  current_tool: string | null;
  status: string | null;
  created_at: string;
};

type Overview = {
  totalStudios: number;
  pendingOwnerInvites: number;
  acceptedOwnerInvites: number;
  studiosNeedingOwner: number;
};

async function loadConsole(): Promise<{
  studios: StudioRow[];
  overview: Overview;
  practitioners: PractitionerRow[];
  waitlist: WaitlistRow[];
  waitlistTotal: number;
  demoRequests: DemoRequestRow[];
}> {
  const admin = createAdminClient();

  const [
    studiosRes,
    invitesRes,
    practitionersRes,
    waitlistRes,
    waitlistCountRes,
    demoRes,
  ] = await Promise.all([
    // Aggregate counts only (no row contents) for setup-health flags.
    admin
      .from("studios")
      .select(
        "id, name, slug, timezone, owner_email, created_at, practitioners(count), clients(count), services(count), studio_availability_default(count)",
      )
      .order("created_at", { ascending: false }),
    // Owner invitations: status + studio only (the email is the owner email,
    // which is operational metadata we already surface elsewhere).
    admin
      .from("pending_invitations")
      .select("studio_id, status")
      .eq("role", "owner"),
    admin
      .from("practitioners")
      .select("id, display_name, email, role, created_at, studio:studios(name)")
      .order("created_at", { ascending: false })
      .limit(20),
    admin
      .from("waitlist")
      .select("id, email, practice_name, created_at")
      .order("created_at", { ascending: false })
      .limit(20),
    admin.from("waitlist").select("id", { count: "exact", head: true }),
    // Explicit projection (not select("*")) — matches the discipline of every
    // other query here and future-proofs against a later column add to
    // demo_requests. Only the operational columns the table renders.
    admin
      .from("demo_requests")
      .select(
        "id, name, email, practice_name, location, practice_type, practitioner_count, current_tool, status, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (studiosRes.error) throw new Error(studiosRes.error.message);
  if (invitesRes.error) throw new Error(invitesRes.error.message);
  if (practitionersRes.error) throw new Error(practitionersRes.error.message);
  if (waitlistRes.error) throw new Error(waitlistRes.error.message);
  if (waitlistCountRes.error) throw new Error(waitlistCountRes.error.message);
  if (demoRes.error) throw new Error(demoRes.error.message);

  type InviteRaw = { studio_id: string; status: string };
  const invites = (invitesRes.data ?? []) as InviteRaw[];
  const acceptedByStudio = new Set(
    invites.filter((i) => i.status === "accepted").map((i) => i.studio_id),
  );
  const pendingByStudio = new Set(
    invites.filter((i) => i.status === "pending").map((i) => i.studio_id),
  );

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
  };

  const studios: StudioRow[] = ((studiosRes.data ?? []) as StudioRaw[]).map(
    (s) => {
      const ownerInviteStatus: OwnerInviteStatus = acceptedByStudio.has(s.id)
        ? "accepted"
        : pendingByStudio.has(s.id)
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
        services_count: s.services?.[0]?.count ?? 0,
        availability_count: s.studio_availability_default?.[0]?.count ?? 0,
        owner_invite_status: ownerInviteStatus,
      };
    },
  );

  const overview: Overview = {
    totalStudios: studios.length,
    pendingOwnerInvites: invites.filter((i) => i.status === "pending").length,
    acceptedOwnerInvites: invites.filter((i) => i.status === "accepted").length,
    studiosNeedingOwner: studios.filter((s) => s.practitioner_count === 0)
      .length,
  };

  // Supabase's typed select() returns the joined `studio` relation as either
  // an object or an array depending on the inferred FK arity; we accept both.
  type PractitionerRaw = {
    id: string;
    display_name: string;
    email: string;
    role: string;
    created_at: string;
    studio: { name: string } | { name: string }[] | null;
  };
  const practitioners: PractitionerRow[] = (
    (practitionersRes.data ?? []) as unknown as PractitionerRaw[]
  ).map((p) => {
    const studioName = Array.isArray(p.studio)
      ? p.studio[0]?.name
      : p.studio?.name;
    return {
      id: p.id,
      display_name: p.display_name,
      email: p.email,
      role: p.role,
      created_at: p.created_at,
      studio_name: studioName ?? "",
    };
  });

  return {
    studios,
    overview,
    practitioners,
    waitlist: (waitlistRes.data ?? []) as WaitlistRow[],
    waitlistTotal: waitlistCountRes.count ?? 0,
    demoRequests: (demoRes.data ?? []) as DemoRequestRow[],
  };
}

export default async function AdminIndexPage() {
  const { studios, overview, practitioners, waitlist, waitlistTotal, demoRequests } =
    await loadConsole();
  // PR #265: operator-visible health of the external every-15-min reminder
  // scheduler. Read the Upstash heartbeat and classify server-side so the
  // status badge does not depend on client-rendered time.
  const reminderScheduler = computeReminderSchedulerStatus(
    await readReminderHeartbeat(),
    Date.now(),
  );

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Internal operator tools for invite-only studio setup.
        </p>
      </header>

      <PaymentsBanner />
      <StudioSetupCard />
      <OverviewCards overview={overview} />
      <ReminderSchedulerCard status={reminderScheduler} />
      <StudiosSection studios={studios} />
      <QuickLinks />

      <hr className="border-neutral-200 dark:border-neutral-800" />

      <PractitionersSection practitioners={practitioners} />
      <WaitlistSection rows={waitlist} total={waitlistTotal} />
      <DemoRequestsSection rows={demoRequests} />
    </div>
  );
}

function PaymentsBanner() {
  return (
    <div
      role="note"
      className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
    >
      Live payments are disabled.
    </div>
  );
}

function StudioSetupCard() {
  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <h2 className="text-lg font-medium">Studio setup</h2>
      <p className="mt-1 max-w-prose text-sm text-neutral-600 dark:text-neutral-400">
        Create a studio and owner invitation for an invite-only pilot studio.
        The owner is added when they first sign in with the invited email.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Link
          href="/admin/studios/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Create new studio
        </Link>
        <span className="text-xs text-neutral-500">
          Setup runbook: docs/20_NEW_STUDIO_SETUP_RUNBOOK.md
        </span>
      </div>
    </section>
  );
}

function ReminderSchedulerCard({ status }: { status: ReminderSchedulerStatus }) {
  const tone =
    status.status === "healthy"
      ? "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
      : status.status === "stale"
        ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
        : "border-neutral-300 bg-neutral-50 text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300";
  const label =
    status.status === "healthy"
      ? "Healthy"
      : status.status === "stale"
        ? "Stale"
        : "Missing";
  return (
    <section className={`rounded-lg border p-5 ${tone}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Reminder scheduler</h2>
        <span className="rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide ring-1 ring-current/30">
          {label}
        </span>
      </div>
      <dl className="mt-3 grid gap-1 text-sm">
        <div className="flex flex-wrap gap-x-2">
          <dt className="opacity-70">Last successful run:</dt>
          <dd>
            {status.lastSuccessAt ? (
              <FormattedDateTime iso={status.lastSuccessAt} />
            ) : (
              "none recorded"
            )}
            {status.ageMinutes != null ? ` (${status.ageMinutes} min ago)` : ""}
          </dd>
        </div>
        <div className="flex flex-wrap gap-x-2">
          <dt className="opacity-70">Expected cadence:</dt>
          <dd>
            every {status.cadenceMinutes} minutes — external scheduler
            (cron-job.org) required
          </dd>
        </div>
      </dl>
      {status.status !== "healthy" && (
        <p className="mt-3 max-w-prose text-sm">
          {status.status === "missing"
            ? "No successful reminder run recorded recently. "
            : `Last success was over ${status.staleAfterMinutes} minutes ago. `}
          Confirm the external scheduler is enabled and calling{" "}
          <code>GET /api/cron/appointment-reminders</code> every{" "}
          {status.cadenceMinutes} min with the{" "}
          <code>Authorization: Bearer $CRON_SECRET</code> header, then check{" "}
          <Link href="/admin/ops-alerts" className="underline">
            Ops alerts
          </Link>{" "}
          for run failures.
        </p>
      )}
    </section>
  );
}

function OverviewCards({ overview }: { overview: Overview }) {
  const cards: { label: string; value: number }[] = [
    { label: "Studios", value: overview.totalStudios },
    { label: "Pending owner invites", value: overview.pendingOwnerInvites },
    { label: "Accepted owner invites", value: overview.acceptedOwnerInvites },
    { label: "Studios needing owner", value: overview.studiosNeedingOwner },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.label}
          className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <div className="text-2xl font-semibold tabular-nums">{c.value}</div>
          <div className="mt-1 text-xs text-neutral-500">{c.label}</div>
        </div>
      ))}
    </section>
  );
}

function Flag({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
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

function InviteBadge({ status }: { status: OwnerInviteStatus }) {
  const text =
    status === "accepted"
      ? "Accepted"
      : status === "pending"
        ? "Pending"
        : "None";
  return <span className="text-neutral-600 dark:text-neutral-400">{text}</span>;
}

function StudiosSection({ studios }: { studios: StudioRow[] }) {
  return (
    <SectionShell title="Studios" subtitle={`${studios.length} total`}>
      {studios.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No studios yet. Use “Create new studio” to set one up.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
              <tr>
                <Th>Name</Th>
                <Th>Booking</Th>
                <Th>Owner email</Th>
                <Th>Timezone</Th>
                <Th>Owner invite</Th>
                <Th>Setup</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {studios.map((s) => (
                <tr key={s.id}>
                  <Td>
                    <Link
                      href={`/admin/studios/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.name}
                    </Link>
                  </Td>
                  <Td>
                    {s.slug ? (
                      <Link
                        href={`/book/${s.slug}`}
                        className="font-mono text-xs hover:underline"
                      >
                        /book/{s.slug}
                      </Link>
                    ) : (
                      <span className="text-neutral-400">—</span>
                    )}
                  </Td>
                  <Td className="text-neutral-600 dark:text-neutral-400">
                    {s.owner_email}
                  </Td>
                  <Td className="text-neutral-600 dark:text-neutral-400">
                    {s.timezone}
                  </Td>
                  <Td>
                    <InviteBadge status={s.owner_invite_status} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Flag ok={s.practitioner_count > 0} label="Owner" />
                      <Flag ok={s.services_count > 0} label="Services" />
                      <Flag ok={s.availability_count > 0} label="Availability" />
                    </div>
                  </Td>
                  <Td className="text-neutral-500">
                    <FormattedDateTime iso={s.created_at} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionShell>
  );
}

function QuickLinks() {
  return (
    <SectionShell title="Operator references">
      <ul className="flex flex-col gap-1 text-sm">
        <li>
          <Link href="/admin/studios/new" className="underline">
            Create new studio
          </Link>
        </li>
        <li>
          <Link href="/admin/ops-alerts" className="underline">
            Ops alerts
          </Link>
        </li>
        <li className="text-neutral-500">
          New studio setup runbook: docs/20_NEW_STUDIO_SETUP_RUNBOOK.md
        </li>
        <li className="text-neutral-500">
          Smoke tests: docs/12_SMOKE_TESTS.md
        </li>
      </ul>
    </SectionShell>
  );
}

function SectionShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-xl font-medium">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function PractitionersSection({
  practitioners,
}: {
  practitioners: PractitionerRow[];
}) {
  return (
    <SectionShell title="Recent practitioners" subtitle="Latest 20">
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Studio</Th>
              <Th>Role</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {practitioners.map((p) => (
              <tr key={p.id}>
                <Td className="font-medium">{p.display_name}</Td>
                <Td className="text-neutral-600 dark:text-neutral-400">
                  {p.email}
                </Td>
                <Td>{p.studio_name}</Td>
                <Td>{p.role}</Td>
                <Td className="text-neutral-500">
                  <FormattedDateTime iso={p.created_at} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function WaitlistSection({ rows, total }: { rows: WaitlistRow[]; total: number }) {
  return (
    <SectionShell
      title="Waitlist"
      subtitle={`${total} total. Latest ${rows.length} shown.`}
    >
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
            <tr>
              <Th>Email</Th>
              <Th>Practice name</Th>
              <Th>Created</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.email}</Td>
                <Td className="text-neutral-600 dark:text-neutral-400">
                  {r.practice_name ?? ""}
                </Td>
                <Td className="text-neutral-500">
                  <FormattedDateTime iso={r.created_at} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function DemoRequestsSection({ rows }: { rows: DemoRequestRow[] }) {
  return (
    <SectionShell title="Demo requests" subtitle={`Latest ${rows.length} shown.`}>
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Practice</Th>
              <Th>Location</Th>
              <Th>Type</Th>
              <Th>Count</Th>
              <Th>Tool</Th>
              <Th>Status</Th>
              <Th>Created</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
            {rows.map((r) => (
              <tr key={r.id}>
                <Td className="font-medium">{r.name}</Td>
                <Td className="text-neutral-600 dark:text-neutral-400">
                  {r.email}
                </Td>
                <Td>{r.practice_name ?? ""}</Td>
                <Td>{r.location ?? ""}</Td>
                <Td>{r.practice_type ?? ""}</Td>
                <Td>{r.practitioner_count ?? ""}</Td>
                <Td>{r.current_tool ?? ""}</Td>
                <Td>{r.status ?? "new"}</Td>
                <Td className="text-neutral-500">
                  <FormattedDateTime iso={r.created_at} />
                </Td>
                <Td>
                  {r.status !== "contacted" && (
                    <form action={markDemoContactedAction}>
                      <input type="hidden" name="id" value={r.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                      >
                        Mark contacted
                      </button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function Th({ children }: { children?: React.ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2 align-top ${className}`}>{children}</td>;
}
