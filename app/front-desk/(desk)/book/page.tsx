import { requireReceptionistWithStudio } from "@/lib/receptionist/identity";
import { getFrontDeskBookingOptions, searchFrontDeskContacts } from "@/lib/receptionist/projections";
import { localDateKey } from "@/lib/receptionist/calendar-days";
import { FrontDeskBookingForm } from "@/components/front-desk/booking-form";

// STUDIO-READY-02c (#824): book an appointment for a treating practitioner.
// The client list comes from the contacts projection (search first), the
// services and practitioners from receptionist_booking_options. The booking
// itself is receptionist_create_appointment over the shared core.
export const dynamic = "force-dynamic";

export default async function FrontDeskBookPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { studio } = await requireReceptionistWithStudio();
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const [options, contacts] = await Promise.all([
    getFrontDeskBookingOptions(studio.id),
    q.length >= 2 ? searchFrontDeskContacts(studio.id, q) : Promise.resolve([]),
  ]);

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-medium">Book an appointment</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Find the client, then choose the service, practitioner and time. Availability, conflicts and buffers are
          checked when you book.
        </p>
      </div>
      <form method="get" className="flex gap-2" role="search" aria-label="Find a client">
        <input
          type="search"
          name="q"
          defaultValue={q}
          minLength={2}
          placeholder="Client name, phone or email"
          className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-950"
        />
        <button type="submit" className="rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700">
          Search
        </button>
      </form>
      {q.length >= 2 && contacts.length === 0 && <p className="text-sm text-neutral-500">No clients match “{q}”.</p>}
      {options.services.length === 0 || options.practitioners.length === 0 ? (
        <p className="text-sm text-neutral-500">
          This studio has no active services or practitioners to book yet. Ask the studio owner to finish setup.
        </p>
      ) : (
        <FrontDeskBookingForm
          clients={contacts.map((c) => ({ id: c.client_id, name: c.name, phone: c.phone }))}
          services={options.services}
          practitioners={options.practitioners}
          defaultDate={localDateKey(new Date().toISOString(), studio.timezone)}
          timezone={studio.timezone}
        />
      )}
    </div>
  );
}
