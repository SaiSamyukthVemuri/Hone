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
  ToggleActiveSubmitButton,
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
          on the booking page. Services you hide from booking stay in history
          for past appointments but won&rsquo;t appear when clients book.
        </p>
        <p className="mt-2 text-xs text-neutral-500">
          Names appear in confirmation emails and on your calendar. Including
          the modality reads cleanly (e.g.{" "}
          <span className="font-medium">Electrolysis 30 min</span>).
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
            <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              {group.label}
            </h3>
            <div className="flex flex-col gap-4">
              {group.services.map((s) => (
                <ServiceCard key={s.id} service={s} />
              ))}
            </div>
          </section>
        ))
      )}

      {inactiveServices.length > 0 && (
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Hidden from booking
            </h3>
            <p className="mt-1 text-xs text-neutral-500">
              Clients won&rsquo;t see these services when booking. Past
              appointments still reference them. Tap{" "}
              <span className="font-medium">Show in booking</span> to bring
              one back.
            </p>
          </div>
          <div className="flex flex-col gap-4 opacity-80">
            {inactiveServices.map((s) => (
              <ServiceCard key={s.id} service={s} />
            ))}
          </div>
        </section>
      )}

      <AddServiceCard />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One service = one card. Inside the card:
//   1. Header: service name + status pill
//   2. Main fields: 2-col grid — Name | Modality, then Duration | Price
//   3. Full-width: Description, then Pre-care instructions
//   4. Advanced (collapsed <details>): Display order
//   5. Footer: Hide/Show on left, Save changes on right
// All form field names are byte-preserved so the unchanged
// updateServiceAction parses identically.
// ---------------------------------------------------------------------------
function ServiceCard({ service }: { service: Service }) {
  return (
    <article className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-base font-medium">{service.name}</h4>
          <p className="mt-0.5 text-xs text-neutral-500">
            {service.active
              ? "Changes apply to future bookings."
              : "Clients won't see this service when booking."}
          </p>
        </div>
        {/* Status pill + visibility toggle. The toggle lives here in its
            OWN form — deliberately OUTSIDE the edit form below. A nested
            <form> is invalid HTML and was the reason the toggle appeared
            to do nothing (the click hit the outer edit form, which never
            touches `active`). */}
        <div className="flex flex-shrink-0 items-center gap-3">
          <StatusPill active={service.active} />
          <ToggleActiveButton id={service.id} active={service.active} />
        </div>
      </header>

      <form
        action={updateServiceAction}
        className="flex flex-col gap-5"
        aria-label={`Edit ${service.name}`}
      >
        <input type="hidden" name="id" value={service.id} />

        {/* Main fields */}
        <div className="grid gap-4 md:grid-cols-2">
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
          <FieldLabel label="Duration">
            <DurationField
              name="default_duration_minutes"
              defaultValue={service.default_duration_minutes}
              required
            />
          </FieldLabel>
          <FieldLabel
            label="Price"
            hint="Shown to clients when booking."
          >
            <PriceInput
              defaultValue={
                service.price_cents != null ? service.price_cents / 100 : ""
              }
            />
          </FieldLabel>
        </div>

        {/* Full-width fields */}
        <FieldLabel
          label="Description"
          hint="Optional. Short copy shown on the booking page."
        >
          <input
            name="description"
            defaultValue={service.description ?? ""}
            placeholder="e.g. 30-minute upper lip session"
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </FieldLabel>

        <FieldLabel
          label="Pre-care instructions"
          hint="Optional. Included in confirmation and reminder emails."
        >
          <textarea
            name="pre_care_instructions"
            defaultValue={service.pre_care_instructions ?? ""}
            rows={2}
            placeholder="e.g. Please arrive 5 minutes early. Skin should be free of lotion or makeup."
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </FieldLabel>

        {/* Advanced — hidden by default. Display order lives here so
            the main form stays calm. Keeps the underlying field name
            sort_order so the unchanged updateServiceAction parses it. */}
        <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Advanced
          </summary>
          <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
            <FieldLabel
              label="Display order"
              hint="Lower numbers show earlier on the booking page."
            >
              <input
                name="sort_order"
                type="number"
                min={0}
                max={100000}
                step={10}
                defaultValue={service.sort_order}
                className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </FieldLabel>
          </div>
        </details>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <span className="text-xs text-neutral-500">
            {service.default_duration_minutes} min ·{" "}
            {formatPrice(service.price_cents)}
          </span>
          <ServiceSubmitButton
            idleLabel="Save changes"
            pendingLabel="Saving…"
          />
        </div>
      </form>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Add-new-service card. Same shape as ServiceCard but without the
// status pill and without the Hide/Show toggle. The "+ Add service"
// button replaces "Save changes" in the footer.
// ---------------------------------------------------------------------------
function AddServiceCard() {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Add a new service
        </h3>
        <p className="mt-1 text-xs text-neutral-500">
          New services appear on your public booking page right away.
        </p>
      </div>

      <article className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
        <form action={createServiceAction} className="flex flex-col gap-5">
          <div className="grid gap-4 md:grid-cols-2">
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
            <FieldLabel label="Duration">
              <DurationField
                name="default_duration_minutes"
                defaultValue={60}
                required
              />
            </FieldLabel>
            <FieldLabel
              label="Price"
              hint="Shown to clients when booking."
            >
              <PriceInput />
            </FieldLabel>
          </div>

          <FieldLabel
            label="Description"
            hint="Optional. Short copy shown on the booking page."
          >
            <input
              name="description"
              placeholder="e.g. 30-minute upper lip session"
              className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
          </FieldLabel>

          <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-neutral-800">
            <ServiceSubmitButton
              idleLabel="+ Add service"
              pendingLabel="Adding…"
              variant="primary"
            />
          </div>
        </form>
      </article>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function StatusPill({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[11px] font-medium text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-200">
        <span
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500"
        />
        Live service
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-neutral-200 px-2.5 py-0.5 text-[11px] font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-500"
      />
      Hidden from booking
    </span>
  );
}

// Standalone visibility-toggle form. Rendered in the card header, never
// nested inside the edit form. Submits toggleServiceActiveAction with the
// flipped `active` value; the action's revalidatePath re-renders the card
// in the new state. The submit button shows in-flight feedback.
function ToggleActiveButton({
  id,
  active,
}: {
  id: string;
  active: boolean;
}) {
  return (
    <form action={toggleServiceActiveAction}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="active" value={active ? "false" : "true"} />
      <ToggleActiveSubmitButton active={active} />
    </form>
  );
}

function PriceInput({
  defaultValue,
}: {
  defaultValue?: number | string;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-neutral-400"
      >
        $
      </span>
      <input
        name="price_dollars"
        type="number"
        min={0}
        step={1}
        defaultValue={defaultValue ?? ""}
        placeholder="-"
        className="w-full rounded-md border border-neutral-300 bg-white py-2 pl-7 pr-3 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
      />
    </div>
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
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        {label}
        {required && <span className="text-neutral-400"> *</span>}
      </span>
      {children}
      {hint && (
        <span className="text-[11px] text-neutral-500">{hint}</span>
      )}
    </label>
  );
}
