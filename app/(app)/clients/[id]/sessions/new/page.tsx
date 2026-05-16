import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { startSessionAction } from "./actions";

export default async function NewSessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);
  if (!data) notFound();

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <div>
        <Link
          href={`/clients/${id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← {data.client.name}
        </Link>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">
          New session
        </h1>
        <p className="mt-1 text-sm text-neutral-500">
          Choose a modality to start charting.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <ModalityCard
          clientId={id}
          modality="electrolysis"
          title="Electrolysis"
          description="Area, probe, mode, intensity, duration."
        />
        <ModalityCard
          clientId={id}
          modality="laser"
          title="Laser"
          description="Zone, fluence, pulse width, spot size."
        />
      </div>
    </div>
  );
}

function ModalityCard({
  clientId,
  modality,
  title,
  description,
}: {
  clientId: string;
  modality: "electrolysis" | "laser";
  title: string;
  description: string;
}) {
  return (
    <form action={startSessionAction}>
      <input type="hidden" name="client_id" value={clientId} />
      <input type="hidden" name="modality" value={modality} />
      <button
        type="submit"
        className="flex w-full flex-col items-start gap-2 rounded-lg border border-neutral-200 bg-white px-5 py-6 text-left transition hover:border-neutral-900 hover:bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-100 dark:hover:bg-neutral-900"
      >
        <span className="text-lg font-medium">{title}</span>
        <span className="text-sm text-neutral-500">{description}</span>
      </button>
    </form>
  );
}
