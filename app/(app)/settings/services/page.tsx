import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAllServices } from "@/lib/booking/queries";
import { groupServicesByModality } from "@/lib/booking/format";
import { KNOWN_MODALITIES, type Service } from "@/lib/types/database";
import {
  createServiceAction,
  toggleServiceActiveAction,
  updateServiceAction,
} from "./actions";
import {
  DurationField,
  ServiceSubmitButton,
} from "./ServiceFormControls";

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
          under one heading. Services hidden from booking stay in history for
          past appointments but don&rsquo;t appear in client booking dropdowns.
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
          No services shown to clients yet. Add one below.
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
                <li key={s.id} className="flex flex-col gap-3 px-4 py-4">
                  <ServiceEditRow service={s} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {inactiveServices.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
              Hidden from booking
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              These services aren&rsquo;t shown to clients on the public booking
              page. Past appointments still reference them. Tap{" "}
              <span className="font-medium">Show in booking</span> to bring one
              back.
            </p>
          </div>
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 opacity-70 dark:divide-neutral-800 dark:border-neutral-800">
            {inactiveServices.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 px-4 py-4">
                <ServiceEditRow service={s} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
            Add a new service
          </h3>
          <p className="mt-1 text-xs text-neutral-500">
            Creates a new service that immediately appears on your public
            booking page.
          </p>
        </div>
        <form action={createServiceAction} className="flex flex-col gap-3">
          <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <FieldLabel label="Service name" required>
              <input
                name="name"
                required
                placeholder="e.g. Electrolysis 30 min"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </FieldLabel>
            <FieldLabel label="Modality">
              <ModalitySelect name="modality" />
            </FieldLabel>
            <FieldLabel
              label="Duration"
              hint="Common: 15 / 30 / 45 / 60 / 90 min"
              required
            >
              <DurationField name="default_duration_minutes" defaultValue={60} required />
            </FieldLabel>
            <FieldLabel label="Price" hint="USD (optional)">
              <input
                name="price_dollars"
                type="number"
                min={0}
                step={1}
                placeholder="—"
                className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </FieldLabel>
            <div className="flex items-end">
              <ServiceSubmitButton
                idleLabel="+ Add service"
                pendingLabel="Adding…"
                variant="primary"
              />
            </div>
          </div>
          <FieldLabel label="Description" hint="Optional">
            <input
              name="description"
              placeholder="Short description shown to clients"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </FieldLabel>
        </form>
      </section>
    </div>
  );
}

function ServiceEditRow({ service }: { service: Service }) {
  return (
    <>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
          {service.active
            ? "Editing live service — changes affect future bookings"
            : "Hidden from booking"}
        </p>
      </div>
      <form action={updateServiceAction} className="flex flex-col gap-3">
        <input type="hidden" name="id" value={service.id} />
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.8fr)_auto]">
          <FieldLabel label="Service name" required>
            <input
              name="name"
              defaultValue={service.name}
              required
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </FieldLabel>
          <FieldLabel label="Modality">
            <ModalitySelect
              name="modality"
              defaultValue={service.modality ?? ""}
            />
          </FieldLabel>
          <FieldLabel label="Duration" hint="Minutes">
            <DurationField
              name="default_duration_minutes"
              defaultValue={service.default_duration_minutes}
              required
            />
          </FieldLabel>
          <FieldLabel label="Price" hint="USD">
            <input
              name="price_dollars"
              type="number"
              min={0}
              step={1}
              placeholder="—"
              defaultValue={
                service.price_cents != null ? service.price_cents / 100 : ""
              }
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </FieldLabel>
          <FieldLabel label="Sort" hint="Lower = earlier">
            <input
              name="sort_order"
              type="number"
              min={0}
              max={100000}
              step={10}
              defaultValue={service.sort_order}
              title="Lower numbers appear first within this modality."
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </FieldLabel>
          <div className="flex items-end">
            <ServiceSubmitButton
              idleLabel="Save changes"
              pendingLabel="Saving…"
            />
          </div>
        </div>
        <FieldLabel label="Description" hint="Optional">
          <input
            name="description"
            defaultValue={service.description ?? ""}
            placeholder="Short description shown to clients"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </FieldLabel>
        <FieldLabel
          label="Pre-care instructions"
          hint="Shown in confirmation + reminder emails"
        >
          <textarea
            name="pre_care_instructions"
            defaultValue={service.pre_care_instructions ?? ""}
            rows={2}
            placeholder="e.g. Please arrive 5 minutes early. Skin should be free of lotion or makeup."
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </FieldLabel>
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
            className="rounded-md border border-neutral-300 px-3 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            {service.active ? "Hide from booking" : "Show in booking"}
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
      className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
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

function FieldLabel({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
        {required && <span className="text-neutral-400"> *</span>}
        {hint && (
          <span className="ml-1 normal-case tracking-normal text-neutral-400">
            · {hint}
          </span>
        )}
      </span>
      {children}
    </label>
  );
}
