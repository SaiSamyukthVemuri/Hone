import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAllServices, servicesHaveCalendarColor } from "@/lib/booking/queries";
import { sortServicesForSettings } from "@/lib/booking/service-order";
import { KNOWN_MODALITIES, type Service } from "@/lib/types/database";
import {
  createServiceAction,
  toggleServiceActiveAction,
  updateServiceAction,
} from "./actions";
import {
  CalendarColorField,
  DurationField,
  ServiceAccordionItem,
  ServiceSubmitButton,
  ToggleActiveSubmitButton,
} from "./ServiceFormControls";
import { ServiceOrderList } from "./ServiceOrderList";

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
  const calendarColorAvailable = await servicesHaveCalendarColor(studio.id);
  // One list, active services first (then hidden), each as a collapsed row.
  // Keeping hidden services inline (rather than in a separate section) means
  // the Hide/Show toggle flips the row's status pill in place instead of
  // relocating the card — clearer feedback.
  //
  // THE ORDER IS NOW SHARED. sortServicesForSettings applies the same TOTAL
  // ordering (sort_order, name, id) that migration 0161's reorder RPC and the
  // public booking page use. The old local sort omitted the `id` term, so tied
  // sort_order values were resolved differently here than on the server — which
  // is why an arrow could point at one row and move another, or silently do
  // nothing at all.
  const orderedServices = sortServicesForSettings(services);

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

      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Service menu order
          </h3>
          <p className="text-xs text-neutral-500">
            The order visible services appear in. Use{" "}
            <span className="font-medium">Move to top / up / down / to bottom</span>{" "}
            on a service to change it. On the public booking page services are
            grouped by modality first (consultations, then electrolysis, then
            laser), and this order applies within each group. Hidden services
            keep their place in history but are not in the booking order.
          </p>
        </div>
        {orderedServices.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
            No services yet. Add one below.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {(() => {
              const visibleIds = orderedServices
                .filter((s) => s.active)
                .map((s) => s.id);
              return (
                <ServiceOrderList
                  rows={orderedServices.map((s) => ({
                    id: s.id,
                    active: s.active,
                    node: (
                      <ServiceAccordionItem
                        name={s.name}
                        durationLabel={`${s.default_duration_minutes} min`}
                        priceLabel={formatPrice(s.price_cents)}
                        active={s.active}
                        colorKey={
                          calendarColorAvailable
                            ? ((s as { calendar_color?: string | null }).calendar_color ?? null)
                            : null
                        }
                        position={s.active ? visibleIds.indexOf(s.id) + 1 : null}
                        toggle={<ToggleActiveButton id={s.id} active={s.active} />}
                      >
                        <ServiceEditForm
                          service={s}
                          calendarColorAvailable={calendarColorAvailable}
                        />
                      </ServiceAccordionItem>
                    ),
                  }))}
                />
              );
            })()}
          </div>
        )}
      </section>

      <AddServiceCard calendarColorAvailable={calendarColorAvailable} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit form for one service — rendered inside the (collapsed-by-default)
// ServiceAccordionItem. The row chrome (name, duration, price, status pill,
// Hide/Show toggle, Edit/Close) lives in the accordion header; this is just
// the form body that appears when the row is expanded. All form field names
// are byte-preserved so the unchanged updateServiceAction parses identically.
// ---------------------------------------------------------------------------
function ServiceEditForm({
  service,
  calendarColorAvailable,
}: {
  service: Service;
  calendarColorAvailable: boolean;
}) {
  return (
    <div className="flex flex-col gap-5">
      <p className="text-xs text-neutral-500">
        {service.active
          ? "Changes apply to future bookings."
          : "Clients won't see this service when booking."}
      </p>

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
          {calendarColorAvailable && (
            <FieldLabel label="Calendar color">
              <CalendarColorField
                name="calendar_color"
                defaultValue={service.calendar_color}
              />
            </FieldLabel>
          )}
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
          label="Pre-appointment instructions"
          hint="Optional. Shown in client confirmation and reminder emails AND in the client portal Care instructions section. Use this for arrival time, clothing, caffeine, shaving, medication reminders, or anything the client should know before this service. Plain text; line breaks are okay."
        >
          <textarea
            name="pre_care_instructions"
            defaultValue={service.pre_care_instructions ?? ""}
            rows={4}
            placeholder="e.g. Please arrive 5 minutes early. Skin should be free of lotion or makeup."
            className="w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
          />
        </FieldLabel>

        {/* Advanced - rarely needed. The Move up / Move down buttons
            on the row header are the primary way to change ordering.
            The raw sort_order field is kept inside this collapsed
            <details> for the rare case a practitioner wants to pin a
            specific number; it stays under "Advanced" so it never
            crowds the normal edit flow. updateServiceAction still
            reads `sort_order` if present. */}
        <details className="rounded-md border border-neutral-200 dark:border-neutral-800">
          <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium uppercase tracking-wider text-neutral-500">
            Advanced
          </summary>
          <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
            <FieldLabel
              label="Position number"
              hint="Most people use the Move up and Move down arrows on the row instead. This is here only for fine-grained control."
            >
              {/* step={1}, not step={10}. Legacy rows hold values like 99, 101
                  and 111 (the old tie-break wrote neighbour±1); with step={10}
                  the browser reported a stepMismatch and silently blocked
                  submission of the WHOLE edit form, so unrelated edits to name,
                  price or care instructions appeared to do nothing. min={0}
                  still holds — the 0161 RPC only ever writes 10, 20, 30 … */}
              <input
                name="sort_order"
                type="number"
                min={0}
                max={100000}
                step={1}
                defaultValue={service.sort_order}
                className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
              />
            </FieldLabel>
          </div>
        </details>

        {/* Footer actions — duration/price already shown in the row summary. */}
        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
          <ServiceSubmitButton
            idleLabel="Save changes"
            pendingLabel="Saving…"
          />
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add-new-service card. Same shape as ServiceCard but without the
// status pill and without the Hide/Show toggle. The "+ Add service"
// button replaces "Save changes" in the footer.
// ---------------------------------------------------------------------------
function AddServiceCard({ calendarColorAvailable }: { calendarColorAvailable: boolean }) {
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
            {calendarColorAvailable && (
              <FieldLabel label="Calendar color">
                <CalendarColorField name="calendar_color" defaultValue="sky" />
              </FieldLabel>
            )}
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

// Standalone visibility-toggle form. Rendered in the accordion row header
// (passed as the `toggle` slot), never nested inside the edit form — this
// preserves the PR #35 fix (a nested <form> is invalid HTML and made the
// toggle "do nothing"). Submits toggleServiceActiveAction with the flipped
// `active` value; the action's revalidatePath re-renders the row with the
// status pill flipped in place. The submit button shows in-flight feedback.
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
