import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAllServices } from "@/lib/booking/queries";
import { groupServicesByModality } from "@/lib/booking/format";
import { KNOWN_MODALITIES, type Service } from "@/lib/types/database";
import {
  createServiceAction,
  toggleServiceActiveAction,
  updateServiceAction,
} from "./actions";

function formatPrice(cents: number | null): string {
  if (cents == null) return "Not set";
  return `$${(cents / 100).toFixed(2)}`;
}

export default async function ServicesSettingsPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can manage services.
      </div>
    );
  }

  const services = await getAllServices(studio.id);
  const activeGroups = groupServicesByModality(services.filter((s) => s.active));
  const inactiveServices = services.filter((s) => !s.active);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="text-xl font-medium">Services</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The list clients pick from when booking. Services group by modality
          on the booking page, so duration variants of the same type collapse
          under one heading. Inactive services stay in history but disappear
          from booking dropdowns.
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Service names appear in confirmation emails and your calendar. We
          recommend including the modality in the name (e.g.{" "}
          <span className="font-medium">Electrolysis 30 min</span>, not just{" "}
          <span className="font-medium">30 min</span>) so emails read clearly.
        </p>
      </section>

      {activeGroups.length === 0 ? (
        <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
          No active services yet. Add one below.
        </p>
      ) : (
        activeGroups.map((group) => (
          <section
            key={group.modality ?? "_other"}
            className="flex flex-col gap-3"
          >
            <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              {group.label}
            </h3>
            <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {group.services.map((s) => (
                <li key={s.id} className="flex flex-col gap-3 px-4 py-3">
                  <ServiceEditRow service={s} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {inactiveServices.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Inactive
          </h3>
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 opacity-60 dark:divide-neutral-800 dark:border-neutral-800">
            {inactiveServices.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 px-4 py-3">
                <ServiceEditRow service={s} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Add a service
        </h3>
        <form action={createServiceAction} className="flex flex-col gap-2">
          <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_6rem_6rem_auto]">
            <input
              name="name"
              required
              placeholder="Service name"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
            <ModalitySelect name="modality" />
            <input
              name="default_duration_minutes"
              type="number"
              min={5}
              max={480}
              step={5}
              defaultValue={60}
              placeholder="Minutes"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
            <input
              name="price_dollars"
              type="number"
              min={0}
              step={1}
              placeholder="Price (optional)"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
            <button
              type="submit"
              className="rounded-md bg-neutral-900 px-3 py-2.5 text-sm font-medium text-white hover:bg-neutral-800 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
            >
              + Add
            </button>
          </div>
          <input
            name="description"
            placeholder="Description (optional)"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </form>
      </section>
    </div>
  );
}

function ServiceEditRow({ service }: { service: Service }) {
  return (
    <>
      <form action={updateServiceAction} className="flex flex-col gap-2">
        <input type="hidden" name="id" value={service.id} />
        <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_6rem_6rem_5rem_auto]">
          <input
            name="name"
            defaultValue={service.name}
            required
            placeholder="Service name"
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <ModalitySelect
            name="modality"
            defaultValue={service.modality ?? ""}
          />
          <input
            name="default_duration_minutes"
            type="number"
            min={5}
            max={480}
            step={5}
            defaultValue={service.default_duration_minutes}
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <input
            name="price_dollars"
            type="number"
            min={0}
            step={1}
            placeholder="Price"
            defaultValue={
              service.price_cents != null ? service.price_cents / 100 : ""
            }
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <input
            name="sort_order"
            type="number"
            min={0}
            max={100000}
            step={10}
            defaultValue={service.sort_order}
            title="Lower numbers appear first within this modality."
            className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-3 py-2 text-xs hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Save
          </button>
        </div>
        <input
          name="description"
          defaultValue={service.description ?? ""}
          placeholder="Description (optional)"
          className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
        />
      </form>
      <div className="flex items-center justify-between gap-3 text-xs text-neutral-500">
        <span>
          {service.default_duration_minutes} min · {formatPrice(service.price_cents)}
        </span>
        <form action={toggleServiceActiveAction}>
          <input type="hidden" name="id" value={service.id} />
          <input
            type="hidden"
            name="active"
            value={service.active ? "false" : "true"}
          />
          <button
            type="submit"
            className="rounded-md border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {service.active ? "Deactivate" : "Reactivate"}
          </button>
        </form>
      </div>
    </>
  );
}

function ModalitySelect({
  name,
  defaultValue,
}: {
  name: string;
  defaultValue?: string;
}) {
  return (
    <select
      name={name}
      defaultValue={defaultValue ?? ""}
      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
    >
      {KNOWN_MODALITIES.map((m) => (
        <option key={m.value} value={m.value}>
          {m.label}
        </option>
      ))}
      <option value="">Other</option>
    </select>
  );
}
