import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { markDemoContactedAction } from "./actions";

type StudioRow = {
  id: string;
  name: string;
  legal_entity_name: string | null;
  owner_email: string;
  created_at: string;
  practitioner_count: number;
  client_count: number;
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

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadDashboard(): Promise<{
  studios: StudioRow[];
  practitioners: PractitionerRow[];
  waitlist: WaitlistRow[];
  waitlistTotal: number;
  demoRequests: DemoRequestRow[];
}> {
  const admin = createAdminClient();

  const [studiosRes, practitionersRes, waitlistRes, waitlistCountRes, demoRes] =
    await Promise.all([
      admin
        .from("studios")
        .select(
          "id, name, legal_entity_name, owner_email, created_at, practitioners(count), clients(count)",
        )
        .order("created_at", { ascending: false }),
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
      admin
        .from("waitlist")
        .select("id", { count: "exact", head: true }),
      admin
        .from("demo_requests")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  if (studiosRes.error) throw new Error(studiosRes.error.message);
  if (practitionersRes.error) throw new Error(practitionersRes.error.message);
  if (waitlistRes.error) throw new Error(waitlistRes.error.message);
  if (waitlistCountRes.error) throw new Error(waitlistCountRes.error.message);
  if (demoRes.error) throw new Error(demoRes.error.message);

  type StudioRaw = {
    id: string;
    name: string;
    legal_entity_name: string | null;
    owner_email: string;
    created_at: string;
    practitioners: { count: number }[] | null;
    clients: { count: number }[] | null;
  };

  const studios: StudioRow[] = ((studiosRes.data ?? []) as StudioRaw[]).map(
    (s) => ({
      id: s.id,
      name: s.name,
      legal_entity_name: s.legal_entity_name,
      owner_email: s.owner_email,
      created_at: s.created_at,
      practitioner_count: s.practitioners?.[0]?.count ?? 0,
      client_count: s.clients?.[0]?.count ?? 0,
    }),
  );

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
    practitioners,
    waitlist: (waitlistRes.data ?? []) as WaitlistRow[],
    waitlistTotal: waitlistCountRes.count ?? 0,
    demoRequests: (demoRes.data ?? []) as DemoRequestRow[],
  };
}

export default async function AdminIndexPage() {
  const { studios, practitioners, waitlist, waitlistTotal, demoRequests } =
    await loadDashboard();

  return (
    <div className="flex flex-col gap-12">
      <header>
        <h1 className="text-3xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Read across every studio. Service role bypasses RLS.
        </p>
      </header>

      <StudiosSection studios={studios} />
      <PractitionersSection practitioners={practitioners} />
      <WaitlistSection rows={waitlist} total={waitlistTotal} />
      <DemoRequestsSection rows={demoRequests} />
    </div>
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
        {subtitle && (
          <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function StudiosSection({ studios }: { studios: StudioRow[] }) {
  return (
    <SectionShell
      title="Studios"
      subtitle={`${studios.length} total`}
    >
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
        <table className="min-w-full text-sm">
          <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
            <tr>
              <Th>Name</Th>
              <Th>Owner</Th>
              <Th>Practitioners</Th>
              <Th>Clients</Th>
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
                <Td className="text-neutral-600 dark:text-neutral-400">
                  {s.owner_email}
                </Td>
                <Td className="tabular-nums">{s.practitioner_count}</Td>
                <Td className="tabular-nums">{s.client_count}</Td>
                <Td className="text-neutral-500">
                  {formatDateTime(s.created_at)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
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
                  {formatDateTime(p.created_at)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}

function WaitlistSection({
  rows,
  total,
}: {
  rows: WaitlistRow[];
  total: number;
}) {
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
                  {formatDateTime(r.created_at)}
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
                  {formatDateTime(r.created_at)}
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
