import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";

// /settings/booking is only a doorway to the Booking link view. A saved/error
// banner addressed to the old URL is carried across.
export default async function BookingSettingsIndex({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePractitionerWithStudio();
  const params = (await searchParams) ?? {};
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const carry = new URLSearchParams();
  const saved = first(params.saved);
  const error = first(params.error);
  if (saved === "1") carry.set("saved", "1");
  if (error !== undefined) carry.set("error", error);
  const qs = carry.toString();
  redirect(`/settings/booking/link${qs ? `?${qs}` : ""}`);
}
