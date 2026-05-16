import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { FormattedDateTime } from "@/components/formatted-date-time";
import type {
  Client,
  PendingInvitation,
  Practitioner,
  Studio,
} from "@/lib/types/database";

async function loadStudio(id: string): Promise<{
  studio: Studio | null;
  practitioners: Practitioner[];
  clients: Pick<Client, "id" | "name" | "created_at">[];
  invitations: PendingInvitation[];
}> {
  const admin = createAdminClient();

  const [studioRes, practitionersRes, clientsRes, invitationsRes] =
    await Promise.all([
      admin.from("studios").select("*").eq("id", id).maybeSingle(),
      admin
        .from("practitioners")
        .select("*")
        .eq("studio_id", id)
        .eq("active", true)
        .order("created_at", { ascending: true }),
      admin
        .from("clients")
        .select("id, name, created_at")
        .eq("studio_id", id)
        .order("name", { ascending: true }),
      admin
        .from("pending_invitations")
        .select("*")
        .eq("studio_id", id)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
    ]);

  if (studioRes.error) throw new Error(studioRes.error.message);
  if (practitionersRes.error) throw new Error(practitionersRes.error.message);
  if (clientsRes.error) throw new Error(clientsRes.error.message);
  if (invitationsRes.error) throw new Error(invitationsRes.error.message);

  return {
    studio: (studioRes.data ?? null) as Studio | null,
    practitioners: (practitionersRes.data ?? []) as Practitioner[],
    clients: (clientsRes.data ?? []) as Pick<
      Client,
      "id" | "name" | "created_at"
    >[],
    invitations: (invitationsRes.data ?? []) as PendingInvitation[],
  };
}

export default async function AdminStudioPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio, practitioners, clients, invitations } = await loadStudio(id);

  if (!studio) notFound();

  return (
    <div className="flex flex-col gap-10">
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
          {studio.legal_entity_name ?? "No legal entity name"}
          {" · "}
          {studio.owner_email}
          {" · created "}
          <FormattedDateTime iso={studio.created_at} />
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">
          Practitioners
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {practitioners.length}
          </span>
        </h2>
        <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
          <table className="min-w-full text-sm">
            <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
              <tr>
                <th className="px-3 py-2 font-medium">Name</th>
                <th className="px-3 py-2 font-medium">Email</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {practitioners.map((p) => (
                <tr key={p.id}>
                  <td className="px-3 py-2 font-medium">{p.display_name}</td>
                  <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                    {p.email}
                  </td>
                  <td className="px-3 py-2">{p.role}</td>
                  <td className="px-3 py-2 text-neutral-500">
                    <FormattedDateTime iso={p.created_at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">
          Clients
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {clients.length}
          </span>
        </h2>
        {clients.length === 0 ? (
          <p className="text-sm text-neutral-500">No clients yet.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-1 rounded-lg border border-neutral-200 p-4 text-sm md:grid-cols-2 dark:border-neutral-800">
            {clients.map((c) => (
              <li key={c.id} className="truncate">
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-medium">
          Pending invitations
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {invitations.length}
          </span>
        </h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-neutral-500">Nothing pending.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800">
            <table className="min-w-full text-sm">
              <thead className="bg-neutral-50 text-left text-xs uppercase tracking-wider text-neutral-500 dark:bg-neutral-900">
                <tr>
                  <th className="px-3 py-2 font-medium">Email</th>
                  <th className="px-3 py-2 font-medium">Role</th>
                  <th className="px-3 py-2 font-medium">Display name</th>
                  <th className="px-3 py-2 font-medium">Invited</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td className="px-3 py-2 font-medium">{inv.email}</td>
                    <td className="px-3 py-2">{inv.role}</td>
                    <td className="px-3 py-2 text-neutral-600 dark:text-neutral-400">
                      {inv.display_name ?? ""}
                    </td>
                    <td className="px-3 py-2 text-neutral-500">
                      <FormattedDateTime iso={inv.created_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
