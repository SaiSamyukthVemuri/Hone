import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioBySlug } from "@/lib/booking/queries";
import { todayInTz } from "@/lib/booking/tz";
import { horizonRangeInStudioTz } from "@/lib/booking/horizon";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { PublicBookForm } from "./PublicBookForm";
import { isNewClientWaitlistEnabled } from "@/lib/booking/new-client-waitlist";
import type { Service } from "@/lib/types/database";
import {
  isPubliclyBookable,
  UNAVAILABLE_PUBLIC_BOOKING_MESSAGE,
} from "@/lib/booking/readiness";

// Public booking portal: deliberately renders WITHOUT the shared
// MarketingHeader. A client landing here from the studio's own website
// (e.g. willowelectrolysis.com -> hone.care/book/<slug>) should feel
// like the studio's booking page, not Hone marketing. The marketing
// header's nav (How it works / Pricing / Demo / Sign in) pulled
// visitors out of the booking flow. The MarketingFooter is kept for
// required legal links (Privacy, Terms, contact). The studio name is
// the page's primary heading so brand identity is preserved.

export default async function PublicBookingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const studio = await getStudioBySlug(slug);
  if (!studio) notFound();

  // Service-role read since this is public.
  const admin = createAdminClient();
  const [{ data: servicesData }, { data: availabilityData }] =
    await Promise.all([
      // THE canonical visible order: (sort_order, name, id), byte-identical to
      // the ordering inside migration 0161's reorder_studio_service RPC and to
      // lib/booking/service-order.ts. The trailing `id` term is what makes it
      // total: without it, services sharing a sort_order came back in heap
      // order, so the public menu could disagree with the settings list.
      // PublicBookForm still GROUPS by modality on top of this (consultations
      // first), which the settings copy now states explicitly.
      admin
        .from("services")
        .select("*")
        .eq("studio_id", studio.id)
        .eq("active", true)
        .order("sort_order", { ascending: true })
        .order("name")
        .order("id"),
      // Soft-gate input: at least one open weekly default day. Cheap (≤7
      // rows). Selecting only the columns we need keeps the wire small.
      admin
        .from("studio_availability_default")
        .select("day_of_week,is_open,open_time,close_time")
        .eq("studio_id", studio.id)
        .eq("is_open", true),
    ]);
  const services = (servicesData ?? []) as Service[];
  const openAvailabilityDaysCount = (availabilityData ?? []).filter(
    (d) =>
      d.is_open === true &&
      typeof d.open_time === "string" &&
      typeof d.close_time === "string",
  ).length;

  // Public soft-gate: render the same calm copy for any incomplete
  // studio (no active services OR no open availability day). Identical
  // wording is intentional, never disclose which piece is missing to
  // a public visitor. The booking actions enforce the same gate.
  const bookable = isPubliclyBookable({
    activeServicesCount: services.length,
    openAvailabilityDaysCount,
  });

  const today = todayInTz(studio.timezone);
  const horizon = horizonRangeInStudioTz(
    studio.timezone,
    studio.public_booking_horizon_months,
  );

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-20 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[760px] flex flex-col gap-10">
          <div>
            <EyebrowCaption>Book an appointment</EyebrowCaption>
            <h1
              className="font-[var(--font-fraunces)] mt-8 text-[44px] font-bold leading-[0.95] md:text-[64px]"
              style={{ letterSpacing: "-0.03em" }}
            >
              {studio.name}
            </h1>
            {studio.booking_description && (
              <p className="mt-6 max-w-[560px] text-[17px] leading-[1.6]">
                {studio.booking_description}
              </p>
            )}
            {studio.address && (
              <p className="mt-6 text-[14px] text-[#6B6B6B]">
                {studio.address}
              </p>
            )}
          </div>

          {bookable ? (
            <PublicBookForm
              slug={studio.slug}
              studioName={studio.name}
              /* P0 new-client waitlist. A DERIVED boolean only: the configured
                 slug allowlist is server-only and never reaches the browser,
                 and this flag is presentation authority only. The public
                 booking server action re-derives it from the server-resolved
                 studio, so a stale tab or forged post cannot book around it. */
              newClientWaitlistEnabled={isNewClientWaitlistEnabled(studio.slug)}
              studioAddress={studio.address ?? null}
              services={services}
              defaultDate={today}
              minDate={horizon.minDateStr}
              maxDate={horizon.maxDateStr}
            />
          ) : (
            <p className="text-[15px] leading-[1.6]" style={{ color: PALETTE.muted }}>
              {UNAVAILABLE_PUBLIC_BOOKING_MESSAGE}
            </p>
          )}
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
