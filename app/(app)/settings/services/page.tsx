import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getAllServices } from "@/lib/booking/queries";
import {
  createServiceAction,
  toggleServiceActiveAction,
  updateServiceAction,
} from "./actions";

function formatPrice(cents: number | null): string {
  if (cents == null) return "—";
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

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="text-xl font-medium">Services</h2>
        <p className="mt-1 text-sm text-neutral-500">
          The list clients pick from when booking. Inactive services stay in
          history but disappear from booking dropdowns.
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Current services
        </h3>
        {services.length === 0 ? (
          <p className="rounded-md border border-dashed border-neutral-300 bg-neutral-50 px-5 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900">
            No services yet. Add one below.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {services.map((s) => (
              <li key={s.id} className="flex flex-col gap-3 px-4 py-3">
                <form action={updateServiceAction} className="flex flex-col gap-2">
                  <input type="hidden" name="id" value={s.id} />
                  <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_7rem_7rem_auto]">
                    <input
                      name="name"
                      defaultValue={s.name}
                      required
                      placeholder="Service name"
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                    <input
                      name="default_duration_minutes"
                      type="number"
                      min={5}
                      max={480}
                      step={5}
                      defaultValue={s.default_duration_minutes}
                      className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                    />
                    <input
                      name="price_dollars"
                      type="number"
                      min={0}
                      step={1}
                      placeholder="Price"
                      defaultValue={
                        s.price_cents != null ? s.price_cents / 100 : ""
                      }
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
                    defaultValue={s.description ?? ""}
                    placeholder="Description (optional)"
                    className="rounded-md border border-neutral-300 bg-white px-3 py-2 text-xs outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
                  />
                </form>
                <div className="flex items-center justify-between gap-3 text-xs text-neutral-500">
                  <span>
                    {s.default_duration_minutes} min · {formatPrice(s.price_cents)}
                  </span>
                  <form action={toggleServiceActiveAction}>
                    <input type="hidden" name="id" value={s.id} />
                    <input
                      type="hidden"
                      name="active"
                      value={s.active ? "false" : "true"}
                    />
                    <button
                      type="submit"
                      className="rounded-md border border-neutral-300 px-2 py-1 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
                    >
                      {s.active ? "Deactivate" : "Reactivate"}
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Add a service
        </h3>
        <form action={createServiceAction} className="flex flex-col gap-2">
          <div className="grid gap-2 md:grid-cols-[minmax(0,2fr)_7rem_7rem_auto]">
            <input
              name="name"
              required
              placeholder="Service name"
              className="rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-100"
            />
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
