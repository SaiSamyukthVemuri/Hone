import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  requirePractitionerWithStudio,
} from "@/lib/supabase/queries";
import { PendingButton } from "@/components/pending-button";
import { ClientForm, type ClientFormValues } from "@/components/client-form";
import { clientDisplayName, type WithPreferredName } from "@/lib/clients/identity";
import { readLegalIdentity } from "@/lib/clients/legal-identity";
import { LegalIdentityForm } from "@/components/legal-identity-form";
import { createClient } from "@/lib/supabase/server";
import { updateClientAction, unarchiveClientAction } from "../actions";
import { ArchiveClientControl } from "./ArchiveClientControl";

export default async function EditClientPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await requirePractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();

  const c = data.client;
  // HON-58: getClientById reads "*", so the column arrives when the database has it.
  const preferredName = (c as WithPreferredName).preferred_name ?? "";
  const initial: ClientFormValues = {
    name: c.name ?? "",
    preferred_name: preferredName,
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

  // HON-58: the legal identity, read with the signed-in client (only an owner or
  // practitioner can see the table). A failed read is shown as unavailable, not
  // as an empty form, so staff never overwrite a legal name they could not see.
  const legal = await readLegalIdentity(await createClient(), id);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {clientDisplayName({ name: c.name, preferred_name: preferredName })}
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
        saveAnywayLabel="Save changes anyway"
      />

      {legal.ok ? (
        <LegalIdentityForm
          clientId={id}
          initial={{
            given: legal.value?.legal_given_name ?? "",
            middle: legal.value?.legal_middle_name ?? "",
            family: legal.value?.legal_family_name ?? "",
          }}
        />
      ) : (
        <p className="rounded-lg border border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
          The legal name could not be loaded right now. Reload the page to try again.
        </p>
      )}

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
            {/* UI-04. HALF OF A PAIR WAS UPGRADED AND THIS HALF WAS NOT.
                UI-R02 gave ArchiveClientControl — directly opposite this, on
                this page — a PendingButton, the 44px floor, press and focus.
                Unarchive kept a raw submit: ~36px, no `active:`, no
                `focus-visible:`, its own dark: pair, and no in-flight state at
                all, so a practitioner clicking it had no way to know whether
                Hone had heard them. Two halves of one decision should not
                behave differently.

                `secondary`, not `danger`: unarchiving restores a client, and
                the solid-danger treatment belongs to the destructive half. */}
            <form action={unarchiveClientAction}>
              <input type="hidden" name="client_id" value={id} />
              <PendingButton variant="secondary" busyLabel="Unarchiving…">
                Unarchive client
              </PendingButton>
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
