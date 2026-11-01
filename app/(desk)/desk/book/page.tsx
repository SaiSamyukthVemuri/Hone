import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireReceptionistWithStudio } from "@/lib/desk/guard";
import type { DeskRpc } from "@/lib/desk/read";
import { readBookingOptions, readStudioTimezone, type BookingOptions } from "@/lib/desk/book";
import { BookForm } from "./BookForm";

// Book an appointment (Sam, 1 Nov). Takes no props, so nothing can be handed to it in a URL (R5).
// It reads two things: the booking options (service names and lengths, practitioner names and
// colours; 0220) and the studio's clock (0274). Both come from the database through the signed-in
// client; the page names no table.

export default async function DeskBookPage() {
  // The layout's guard does not stop this page from running: it resolves identity itself.
  const identity = await requireReceptionistWithStudio();
  let options: BookingOptions | null = null;
  let timezone: string | null = null;
  try {
    const db = (await createClient()) as unknown as DeskRpc;
    [options, timezone] = await Promise.all([readBookingOptions(db, identity.studioId), readStudioTimezone(db, identity.studioId)]);
  } catch {
    options = null;
    timezone = null;
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Book an appointment</h1>
        <p className="mt-1 text-sm text-neutral-500">
          <Link href="/desk" className="underline">Back to the schedule</Link>
        </p>
      </div>
      {options === null || timezone === null ? (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-6 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          Booking is unavailable right now. Try again in a moment.
        </p>
      ) : (
        <BookForm options={options} timezone={timezone} />
      )}
    </div>
  );
}
