import { FormDirtyGuard } from "@/components/settings/form-dirty-guard";
import { OwnerOnlyNotice } from "@/components/settings/view-heading";
import { FieldLabel, fieldControlClass } from "@/components/ui/field";
import { SectionLabel } from "@/components/ui/section-label";
import { getAllServices, servicesHaveCalendarColor } from "@/lib/booking/queries";
import { groupServicesByModality } from "@/lib/booking/format";
import { sortServicesForSettings } from "@/lib/booking/service-order";
import { resolveTimeFormat, type TimeFormat } from "@/lib/booking/tz";
import { isServiceColorKey } from "@/lib/calendar/service-colors";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { KNOWN_MODALITIES, type Service } from "@/lib/types/database";
import { createServiceAction, toggleServiceActiveAction, updateServiceAction } from "./actions";
import { CalendarColorField, DurationField, ToggleActiveSubmitButton } from "./ServiceFormControls";
import { ServiceOrderList, ServiceSaveForm } from "./ServiceOrderList";

export default async function ServicesSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return <OwnerOnlyNotice>Only studio owners can manage services.</OwnerOnlyNotice>;
  }

  const [services, calendarColorAvailable] = await Promise.all([
    getAllServices(studio.id), servicesHaveCalendarColor(studio.id),
  ]);
  const timeFormat = resolveTimeFormat(studio);
  const orderedServices = sortServicesForSettings(services);
  return (
    <section className="min-w-0 space-y-4">
      <div>
        <h2 tabIndex={-1} data-settings-heading className="text-2xl font-semibold tracking-tight outline-none">Services</h2>
        <p className="mt-1 text-sm text-fg-muted">Manage your booking menu and how each service appears on the calendar.</p>
      </div>
      <ServiceOrderList
        groups={groupServicesByModality(orderedServices.filter((s) => s.active)).map((group) => ({
          label: group.label, ids: group.services.map((s) => s.id),
        }))}
        rows={orderedServices.map((service) => ({
          id: service.id,
          name: service.name,
          active: service.active,
          duration: service.default_duration_minutes,
          price: service.price_cents === null ? "Price not set" : `$${(service.price_cents / 100).toFixed(2)}`,
          colorKey: calendarColorAvailable && isServiceColorKey(service.calendar_color) ? service.calendar_color : null,
          editor: <ServiceForm service={service} calendarColorAvailable={calendarColorAvailable} timeFormat={timeFormat} />,
          visibility: (
            <form action={toggleServiceActiveAction}>
              <input type="hidden" name="id" value={service.id} />
              <input type="hidden" name="active" value={service.active ? "false" : "true"} />
              <ToggleActiveSubmitButton active={service.active} />
            </form>
          ),
        }))}
        createEditor={<ServiceForm calendarColorAvailable={calendarColorAvailable} timeFormat={timeFormat} />}
      />
    </section>
  );
}

function ServiceForm({ service, calendarColorAvailable, timeFormat }: {
  service?: Service;
  calendarColorAvailable: boolean;
  timeFormat: TimeFormat;
}) {
  const name = service?.name ?? "";
  const duration = service?.default_duration_minutes ?? 60;
  return (
    <ServiceSaveForm
      serviceId={service?.id}
      title={service?.name ?? "Add a service"}
      saveAction={service ? updateServiceAction : createServiceAction}
    >
      {service ? (
        <FormDirtyGuard name={`service-edit-${service.id}`} token={Date.now().toString(36)} />
      ) : (
        <FormDirtyGuard name="service-create" token={Date.now().toString(36)} />
      )}
      {service && <input type="hidden" name="id" value={service.id} />}
      <div className={calendarColorAvailable ? "grid min-w-0 @[655px]/editor:grid-cols-[minmax(0,.95fr)_minmax(0,1.05fr)]" : ""}>
        {calendarColorAvailable && (
          <div className="min-w-0 border-b border-line p-4 @[655px]/editor:border-r @[655px]/editor:border-b-0">
            <CalendarColorField
              name="calendar_color"
              defaultValue={service?.calendar_color ?? "sky"}
              previewName={name}
              previewDuration={duration}
              timeFormat={timeFormat}
            />
          </div>
        )}
        <div className="min-w-0 space-y-4 p-4">
          <SectionLabel as="h4">Service details</SectionLabel>
          <FieldLabel label="Service name" required>
            <input name="name" defaultValue={name} required placeholder="e.g. Electrolysis 30 min" className={fieldControlClass()} />
          </FieldLabel>
          <fieldset className="min-w-0 space-y-1.5">
            <legend><SectionLabel size="caption">Duration</SectionLabel></legend>
            <DurationField name="default_duration_minutes" defaultValue={duration} required />
          </fieldset>
          <div className="grid gap-4 @[810px]/editor:grid-cols-2">
            <FieldLabel label="Price">
              <div className="relative">
                <span aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-muted">$</span>
                <input
                  name="price_dollars" type="number" min={0} step="0.01" inputMode="decimal"
                  defaultValue={service?.price_cents != null ? service.price_cents / 100 : ""}
                  className={fieldControlClass({ className: "pl-7 tabular-nums" })}
                />
              </div>
            </FieldLabel>
            <FieldLabel label="Modality">
              <select name="modality" defaultValue={service?.modality ?? ""} className={fieldControlClass()}>
                {KNOWN_MODALITIES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                {service?.modality && !KNOWN_MODALITIES.some((m) => m.value === service.modality) && (
                  <option value={service.modality}>{service.modality}</option>
                )}
                <option value="">Other</option>
              </select>
            </FieldLabel>
          </div>
          <details className="group border-t border-line">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
              <span aria-hidden className="size-2 -rotate-45 border-r border-b border-current group-open:rotate-45" />
              Booking description &amp; care instructions
            </summary>
            <div className="space-y-4 pb-2">
              <FieldLabel label="Booking description">
                <input name="description" defaultValue={service?.description ?? ""} className={fieldControlClass()} />
              </FieldLabel>
              <FieldLabel label="Pre-appointment instructions" hint="Shown in confirmation and reminder emails and under Care instructions in the client portal.">
                <textarea name="pre_care_instructions" defaultValue={service?.pre_care_instructions ?? ""} rows={3} className={fieldControlClass()} />
              </FieldLabel>
            </div>
          </details>
          {service && (
            <details className="group border-t border-line">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="size-2 -rotate-45 border-r border-b border-current group-open:rotate-45" />
                Advanced
              </summary>
              <FieldLabel label="Position number" hint="Use Reorder in the service menu to move a service by one position.">
                <input name="sort_order" type="number" min={0} max={100000} step={1} defaultValue={service.sort_order}
                  className={fieldControlClass({ fullWidth: false, className: "w-28 tabular-nums" })} />
              </FieldLabel>
            </details>
          )}
          {!service && <p className="text-sm text-fg-muted">Adding this service makes it available in your booking menu.</p>}
        </div>
      </div>
    </ServiceSaveForm>
  );
}
