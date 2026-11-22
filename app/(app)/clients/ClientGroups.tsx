"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PendingLink } from "@/components/pending-link";
import { CONTROL_MIN_TOUCH, FOCUS_RING } from "@/components/ui/control-base";
import { type ClientGroup, type GroupRead } from "@/lib/client-groups/model";
import { changeClientGroup } from "./group-actions";

async function safelyChange(input: Parameters<typeof changeClientGroup>[0]) {
  try { return await changeClientGroup(input); }
  catch { return { ok: false as const, error: "We couldn't confirm that change. Reload to check the current groups before trying again." }; }
}

const field = `${CONTROL_MIN_TOUCH} ${FOCUS_RING} w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm`;

export function ClientGroupsCard({ clientId, catalogue, assigned }: {
  clientId: string; catalogue: GroupRead<ClientGroup[]>; assigned: GroupRead<ClientGroup[]>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [chosen, setChosen] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const assignedIds = new Set(assigned.available ? assigned.value.map((g) => g.id) : []);
  const choices = catalogue.available ? catalogue.value.filter((g) => !assignedIds.has(g.id)) : [];
  function change(groupId: string, adding: boolean) {
    setError(""); setMessage("");
    startTransition(async () => {
      const result = await safelyChange({ kind: "membership", clientId, groupId, assigned: adding });
      if (result.ok) { setMessage(result.message); if (adding) setChosen(""); router.refresh(); }
      else setError(result.error);
    });
  }
  return <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">Client groups</h2>
      <PendingLink href="/clients/groups" className="inline-flex min-h-11 items-center text-sm underline">Manage groups</PendingLink>
    </div>
    <p className="text-sm text-neutral-500">Organise this client. Groups don&apos;t change booking access, consent or treatment status.</p>
    {!catalogue.available || !assigned.available ? <p role="status" className="text-sm text-neutral-600">Client groups are unavailable. Reload to try again.</p> : <>
      <ul aria-label="Assigned client groups" className="flex flex-wrap gap-2">
        {assigned.value.map((group) => <li key={group.id} className="flex max-w-full items-center gap-1 rounded-lg border border-neutral-200 pl-3">
          <span className="min-w-0 break-words text-sm">{group.name}</span>
          <Button size="sm" variant="quiet" disabled={pending} aria-label={`Remove ${group.name}`} onClick={() => change(group.id, false)}>Remove</Button>
        </li>)}
      </ul>
      {assigned.value.length === 0 && <p className="text-sm text-neutral-500">No groups assigned.</p>}
      {choices.length > 0 ? <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (chosen) change(chosen, true); }}>
        <label className="min-w-0 flex-1 break-words text-sm">Add to group
          <select className={`${field} mt-1`} value={chosen} onChange={(event) => setChosen(event.target.value)} disabled={pending}>
            <option value="">Choose a group</option>
            {choices.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <Button type="submit" pending={pending} disabled={!chosen}>Add group</Button>
      </form> : catalogue.value.length === 0 ? <p className="text-sm text-neutral-500">Create a group in Manage groups to get started.</p> : null}
    </>}
    <p role="status" aria-live="polite" className="text-sm text-neutral-600">{pending ? "Saving group change…" : message}</p>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
  </section>;
}

function GroupNameForm({ group }: { group?: ClientGroup }) {
  const router = useRouter();
  const [name, setName] = useState(group?.name ?? "");
  // Retain the baseline with this draft. A refresh from another form must not
  // silently upgrade the version of an unsaved edit.
  const [baseline, setBaseline] = useState(group);
  const [savedName, setSavedName] = useState<string | null>(null);
  useEffect(() => {
    if (group && group.updated_at !== baseline?.updated_at && (name === baseline?.name || name === savedName)) {
      setName(group.name); setBaseline(group); setSavedName(null);
    }
  }, [group, baseline, name, savedName]);
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  return <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => {
    event.preventDefault(); setFeedback(null);
    startTransition(async () => {
      const result = await safelyChange(group ? { kind: "rename", groupId: group.id, name, expectedName: baseline!.name, expectedUpdatedAt: baseline!.updated_at } : { kind: "create", name });
      setFeedback({ error: !result.ok, text: result.ok ? result.message : result.error });
      if (result.ok) { if (!group) setName(""); else setSavedName(name.trim()); router.refresh(); }
    });
  }}>
    <label className="min-w-0 flex-1 break-words text-sm">{group ? `Group name: ${group.name}` : "New group name"}
      <input className={`${field} mt-1`} value={name} onChange={(event) => setName(event.target.value)} maxLength={60} required disabled={pending} autoComplete="off" />
    </label>
    <Button type="submit" pending={pending} variant={group ? "secondary" : "primary"}>{group ? "Rename" : "Create group"}</Button>
    <p className="w-full text-sm text-neutral-600" role={feedback?.error ? "alert" : "status"} aria-live="polite">{feedback?.text}</p>
  </form>;
}

export function GroupCatalogue({ groups }: { groups: ClientGroup[] }) {
  return <div className="flex flex-col gap-6">
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5">
      <p className="text-sm text-neutral-600">Group names are visible to owners only. Don&apos;t put health details or reasons for treatment in a name.</p>
      <GroupNameForm />
    </section>
    <section className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5">
      <h2 className="text-lg font-medium">Your groups <span className="text-sm font-normal text-neutral-500">{groups.length} of 100</span></h2>
      {groups.length === 0 ? <p className="text-sm text-neutral-500">No groups yet. Create your first group above.</p> : groups.map((group) => <GroupNameForm key={group.id} group={group} />)}
    </section>
  </div>;
}
