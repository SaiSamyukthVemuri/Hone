import Link from "next/link";
import {
  getClientsForStudio,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { ClientSearch } from "@/components/client-search";

export default async function ClientsPage() {
  const { studio } = await getCurrentPractitionerWithStudio();
  const clients = await getClientsForStudio(studio.id);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Clients</h1>
          <p className="mt-1 text-sm text-neutral-500">
            {clients.length === 0
              ? "No clients yet."
              : `${clients.length} ${clients.length === 1 ? "client" : "clients"}`}
          </p>
        </div>
        <Link
          href="/clients/new"
          className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          + Add client
        </Link>
      </div>

      <ClientSearch clients={clients} emptyLabel="No clients yet." />
    </div>
  );
}
