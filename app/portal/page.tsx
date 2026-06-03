import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { PublicPolicyReminderCard } from "@/app/_components/PublicPolicyReminderCard";
import { getCurrentPortalSession } from "@/lib/portal/session";
import {
  getPortalIdentity,
  getPortalIntakeStatus,
  getPortalUpcomingAppointments,
} from "@/lib/portal/queries";
import { portalLogoutAction } from "./logout/actions";

// Authenticated client portal home.
//
// Resolves the portal session server-side. No session → redirect to
// /portal/login. With session → render only client-safe surfaces:
//   * greeting with first name
//   * upcoming appointments (date / time / service / Manage button)
//   * intake status (link if outstanding, "complete" badge otherwise)
//   * studio cancellation + no-show policies
//
// What this page deliberately does NOT render (defence-in-depth so a
// future contributor cannot widen the surface by accident):
//   * practitioner notes, treatment plan internals, charting,
//     session blocks, audit logs, SMS logs, payment / card details,
//     any other client's data, archived client data.
//
// Every piece of data here comes from lib/portal/queries.ts, which is
// scoped to the resolved (studioId, clientId) and never touches the
// columns or tables those surfaces would require.

export default async function PortalHomePage() {
  const session = await getCurrentPortalSession();
  if (!session) {
    redirect("/portal/login");
  }

  const identity = await getPortalIdentity(session.studioId, session.clientId);
  if (!identity) {
    // Session is technically live but the underlying client row is
    // gone or archived. Treat the same as logged out so the visitor
    // sees a clean public surface.
    redirect("/portal/login");
  }

  const [upcoming, intake] = await Promise.all([
    getPortalUpcomingAppointments(session.studioId, session.clientId),
    getPortalIntakeStatus(session.studioId, session.clientId),
  ]);

  const { client, studio } = identity;

  return (
    <main
      style={{
        backgroundColor: PALETTE.bg,
        color: PALETTE.ink,
        fontFeatureSettings: '"cv11"',
      }}
      className="min-h-screen font-[var(--font-inter)]"
    >
      <section className="px-6 py-16 md:px-12 lg:px-16">
        <div className="mx-auto max-w-[760px] flex flex-col gap-10">
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <EyebrowCaption>{studio.name}</EyebrowCaption>
              <h1
                className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[44px]"
                style={{ letterSpacing: "-0.025em" }}
              >
                Hello, {client.firstName}.
              </h1>
              <p className="mt-4 text-[16px] leading-relaxed text-[#0A0A0A]">
                Your upcoming appointments and forms live here. Manage
                each appointment from the link below.
              </p>
            </div>
            <form action={portalLogoutAction}>
              <button
                type="submit"
                className="text-[13px] underline"
                style={{ color: "#6B6B6B" }}
              >
                Sign out
              </button>
            </form>
          </header>

          <section className="flex flex-col gap-3">
            <h2
              className="text-[12px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
            >
              Upcoming appointments
            </h2>
            {upcoming.length === 0 ? (
              <p className="text-[15px] leading-relaxed text-[#0A0A0A]">
                You don&rsquo;t have any upcoming appointments. When{" "}
                {studio.name} books you in, your appointments will appear
                here.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {upcoming.map((appt) => (
                  <li
                    key={appt.id}
                    className="flex flex-col gap-2 p-6 sm:flex-row sm:items-baseline sm:justify-between"
                    style={{
                      backgroundColor: "#FAFAF7",
                      border: "1px solid #E5E2D9",
                    }}
                  >
                    <div className="flex flex-col gap-1 min-w-0">
                      <p className="text-[15px] font-medium text-[#0A0A0A]">
                        {appt.serviceName}
                        <span style={{ color: "#6B6B6B" }}>
                          {" · "}
                          {appt.durationMinutes} min
                        </span>
                      </p>
                      <p className="text-[14px]" style={{ color: "#3F3F3F" }}>
                        <FormattedDateTime iso={appt.startsAt} />
                      </p>
                    </div>
                    {appt.manageToken && (
                      <Link
                        href={`/manage/${appt.manageToken}`}
                        className="self-start px-5 py-2 text-[12px] font-medium uppercase"
                        style={{
                          border: "1px solid #0A0A0A",
                          color: "#0A0A0A",
                          letterSpacing: "0.1em",
                        }}
                      >
                        Manage
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <h2
              className="text-[12px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
            >
              Intake
            </h2>
            {intake.kind === "complete" && (
              <p className="text-[15px] text-[#0A0A0A]">
                Intake complete.{" "}
                <span style={{ color: "#6B6B6B" }}>
                  {studio.name} has your latest health and consent
                  responses on file.
                </span>
              </p>
            )}
            {intake.kind === "outstanding" && (
              <div className="flex flex-col gap-2">
                <p className="text-[15px] text-[#0A0A0A]">
                  Your intake form is outstanding. Finishing it ahead of
                  your appointment helps {studio.name} prepare.
                </p>
                <Link
                  href={intake.url}
                  className="self-start px-5 py-2 text-[12px] font-medium uppercase"
                  style={{
                    backgroundColor: "#0A0A0A",
                    color: "#FAFAF7",
                    letterSpacing: "0.1em",
                  }}
                >
                  Open intake form
                </Link>
              </div>
            )}
            {intake.kind === "unavailable" && (
              <p className="text-[14px]" style={{ color: "#6B6B6B" }}>
                No intake form is required right now.
              </p>
            )}
          </section>

          <PublicPolicyReminderCard
            cancellationPolicyText={studio.cancellationPolicyText}
            noShowPolicyText={studio.noShowPolicyText}
            studioName={studio.name}
          />

          <p className="text-[12px]" style={{ color: "#6B6B6B" }}>
            Session expires{" "}
            <FormattedDateTime iso={session.expiresAt} />. Sign out at
            any time to revoke this session.
          </p>
        </div>
      </section>
      <MarketingFooter />
    </main>
  );
}
