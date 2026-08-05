import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { ClientForm, type ClientFormValues } from "@/components/client-form";
import { updateClientAction, unarchiveClientAction } from "../actions";
import { ArchiveClientControl } from "./ArchiveClientControl";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();

  const c = data.client;
  const initial: ClientFormValues = {
    name: c.name ?? "",
    pronouns: c.pronouns ?? "",
    date_of_birth: c.date_of_birth ?? "",
    phone: c.phone ?? "",
    email: c.email ?? "",
    address: c.address ?? "",
    fitzpatrick_type:
      c.fitzpatrick_type != null ? String(c.fitzpatrick_type) : "",
    allergies: c.allergies ?? "",
    emergency_contact_name: c.emergency_contact_name ?? "",
    emergency_contact_phone: c.emergency_contact_phone ?? "",
  };

  const isArchived = c.archived_at != null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {c.name}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Edit client</h1>
      </div>

      <ClientForm
        action={updateClientAction}
        initialValues={initial}
        submitLabel="Save changes"
        pendingLabel="Saving…"
        cancelHref={`/clients/${id}`}
        hiddenFields={{ client_id: id }}
      />

      {/* Archive / unarchive sits at the bottom of the edit page so a
          practitioner editing a client cannot accidentally hit it
          while saving routine field changes. Archive opens a
          confirmation step (ArchiveClientControl); unarchive is a
          one-click submit because un-hiding is non-destructive. */}
      <section className="flex flex-col gap-3 border-t border-neutral-200 pt-6 dark:border-neutral-800">
        <h2 className="text-base font-medium text-neutral-900 dark:text-neutral-100">
          {isArchived ? "Archived client" : "Archive this client"}
        </h2>
        {isArchived ? (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              This client is hidden from active lists, search, and the
              dashboard birthday surface. Historical records still
              exist (past appointments, sessions, intake, audit) and
              are reachable from this page.
            </p>
            <form action={unarchiveClientAction}>
              <input type="hidden" name="client_id" value={id} />
              <button
                type="submit"
                className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                Unarchive client
              </button>
            </form>
          </>
        ) : (
          <>
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Removes the client from active lists and search. Use this
              for test clients and duplicate entries. Historical
              records (past appointments, sessions, intake, audit) are
              preserved and remain reachable from this page. Real
              client deletion is not supported.
            </p>
            <ArchiveClientControl clientId={id} clientName={c.name} />
          </>
        )}
      </section>
    </div>
  );
}
