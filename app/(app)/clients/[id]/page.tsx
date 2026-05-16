import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getClientById,
  getCurrentPractitionerWithStudio,
} from "@/lib/supabase/queries";
import { FITZPATRICK_TYPES } from "@/lib/constants";
import {
  ElectrolysisEntryList,
  LaserEntryList,
  SessionTimeline,
} from "@/components/session-timeline";
import { AddPricingForm } from "@/components/add-pricing-form";
import {
  addClientPricingAction,
  deleteClientPricingAction,
} from "./actions";

function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fitzpatrickLabel(value: number | null): string {
  if (value == null) return "—";
  const match = FITZPATRICK_TYPES.find((f) => f.value === value);
  return match ? match.label : String(value);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function ClientCheatSheetPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { studio } = await getCurrentPractitionerWithStudio();
  const data = await getClientById(studio.id, id);

  if (!data) {
    notFound();
  }

  const { client, pricing, sessions } = data;
  const lastSession = sessions[0];
  const olderSessions = sessions.slice(1);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <Link
          href="/clients"
          className="text-sm text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          ← Clients
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">
              {client.name}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
              {client.pronouns && <span>{client.pronouns}</span>}
              {client.phone && <span>· {client.phone}</span>}
              {client.email && <span>· {client.email}</span>}
            </div>
          </div>
          <Link
            href={`/clients/${client.id}/sessions/new`}
            className="rounded-md bg-neutral-900 px-5 py-3 text-base font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Log session
          </Link>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Pricing
          </h2>
          {pricing.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No custom pricing — studio defaults apply.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
              {pricing.map((p) => (
                <li
                  key={p.id}
                  className="flex items-start justify-between gap-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="font-medium">{p.service_name}</span>
                      <span className="tabular-nums">
                        {formatPrice(p.price_cents)}
                      </span>
                    </div>
                    {p.notes && (
                      <div className="text-xs text-neutral-500">{p.notes}</div>
                    )}
                  </div>
                  <form action={deleteClientPricingAction}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="client_id" value={client.id} />
                    <button
                      type="submit"
                      aria-label={`Delete ${p.service_name} pricing`}
                      className="rounded-md border border-neutral-300 px-2 py-0.5 text-xs text-neutral-500 hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
                    >
                      ✕
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-neutral-200 pt-3 dark:border-neutral-800">
            <AddPricingForm
              clientId={client.id}
              action={addClientPricingAction}
            />
          </div>
        </div>

        <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
          <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Skin
          </h2>
          <dl className="mt-3 flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">Fitzpatrick</dt>
              <dd className="font-medium">
                {fitzpatrickLabel(client.fitzpatrick_type)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-500">Date of birth</dt>
              <dd className="font-medium">{client.date_of_birth ?? "—"}</dd>
            </div>
          </dl>
          {client.skin_notes && (
            <p className="mt-3 whitespace-pre-wrap text-sm text-neutral-700 dark:text-neutral-300">
              {client.skin_notes}
            </p>
          )}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Last session</h2>
        {lastSession ? (
          <div className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div>
                <div className="text-sm font-medium">
                  {formatDate(lastSession.started_at)}
                </div>
                <div className="text-xs text-neutral-500">
                  {lastSession.modality}
                </div>
              </div>
              <Link
                href={`/clients/${client.id}/sessions/${lastSession.id}`}
                className="text-xs font-medium text-neutral-700 hover:underline dark:text-neutral-300"
              >
                Open →
              </Link>
            </div>
            <div className="mt-4">
              {lastSession.modality === "electrolysis" ? (
                <ElectrolysisEntryList
                  entries={lastSession.electrolysis_entries}
                />
              ) : (
                <LaserEntryList entries={lastSession.laser_entries} />
              )}
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
            No sessions logged yet.
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">All sessions</h2>
        <SessionTimeline clientId={client.id} sessions={olderSessions} />
      </section>
    </div>
  );
}
