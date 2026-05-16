import Link from "next/link";
import { ClientForm } from "@/components/client-form";
import { createClientAction } from "./actions";

export default function NewClientPage() {
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
