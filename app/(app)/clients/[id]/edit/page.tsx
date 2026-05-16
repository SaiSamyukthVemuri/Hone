import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { ClientForm, type ClientFormValues } from "@/components/client-form";
import { updateClientAction } from "../actions";

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
    fitzpatrick_type:
      c.fitzpatrick_type != null ? String(c.fitzpatrick_type) : "",
    skin_notes: c.skin_notes ?? "",
    allergies: c.allergies ?? "",
  };

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
    </div>
  );
}
