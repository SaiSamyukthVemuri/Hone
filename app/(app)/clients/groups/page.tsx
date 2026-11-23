import { notFound } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { readGroups } from "@/lib/client-groups/queries";
import { PendingLink } from "@/components/pending-link";
import { GroupCatalogue } from "../ClientGroups";

export default async function GroupsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") notFound();
  const groups = await readGroups(await createClient(), studio.id, true);
  return <div className="flex flex-col gap-6">
    <PendingLink href="/clients" className="inline-flex min-h-11 items-center text-sm text-neutral-500 underline">Back to clients</PendingLink>
    <div><h1 className="text-3xl font-semibold tracking-tight">Client groups</h1>
      <p className="mt-1 text-sm text-neutral-500">Create groups to organise your clients. A client can belong to more than one group.</p>
      <p className="mt-2 text-sm text-neutral-500">Groups are visible to owners only. They don&apos;t change treatment status, payments, consent, booking access or Active / Archived status.</p>
    </div>
    {groups.available ? <GroupCatalogue groups={groups.value} /> : <div role="status" className="rounded-lg border border-neutral-200 p-5 text-sm">Client groups are unavailable. Reload to try again. Your clients are still available in the directory.</div>}
  </div>;
}
