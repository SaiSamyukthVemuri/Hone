import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioBySlug } from "@/lib/booking/queries";
import { todayInTz } from "@/lib/booking/tz";
import { MarketingHeader } from "@/app/_components/MarketingHeader";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { PublicBookForm } from "./PublicBookForm";
import type { Service } from "@/lib/types/database";

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
  const { data: servicesData } = await admin
    .from("services")
    .select("*")
    .eq("studio_id", studio.id)
    .eq("active", true)
    .order("name");
  const services = (servicesData ?? []) as Service[];

  const today = todayInTz(studio.timezone);

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <MarketingHeader />
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

          <PublicBookForm
            slug={studio.slug}
            services={services}
            defaultDate={today}
          />
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
