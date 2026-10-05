import Link from "next/link";
import { ClientForm } from "@/components/client-form";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClientAction } from "./actions";

export default async function NewClientPage() {
  // This page reads no studio data, but it still resolves identity itself
  // (SENTRY-IDENTITY-01): the shell layout's guard does not run on a soft
  // navigation, so without this a practitioner removed after the middleware
  // admitted the request would be handed the form instead of /no-access.
  await requirePractitionerWithStudio();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href="/clients"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Clients
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">New client</h1>
      </div>

      <ClientForm
        action={createClientAction}
        submitLabel="Save client"
        pendingLabel="Saving…"
        cancelHref="/clients"
      />
    </div>
  );
}
