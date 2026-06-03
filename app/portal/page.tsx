import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { MarkdownLiteBlock } from "@/app/_components/MarkdownLiteBlock";
import { getCurrentPortalSession } from "@/lib/portal/session";
import {
  getPortalIdentity,
  getPortalIntakeStatus,
  getPortalMessagesForClient,
  getPortalRepliesForClient,
  getPortalUpcomingAppointments,
  getPortalUpcomingPreCare,
} from "@/lib/portal/queries";
import { portalLogoutAction } from "./logout/actions";
import { markPortalMessageReviewedAction } from "./portal-message-actions";
import { PortalReplyForm } from "./PortalReplyForm";
import {
  getActiveConsentTemplatesForPortal,
  getLatestSignaturesByTemplateForPortal,
} from "@/lib/consent/queries";
import { PortalConsentForms } from "./PortalConsentForms";

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

  const [
    upcoming,
    intake,
    preCareEntries,
    messages,
    replies,
    consentTemplates,
    consentSignaturesByTemplate,
  ] = await Promise.all([
    getPortalUpcomingAppointments(session.studioId, session.clientId),
    getPortalIntakeStatus(session.studioId, session.clientId),
    getPortalUpcomingPreCare(session.studioId, session.clientId),
    // Migration 0053: secure portal messages from the studio.
    // Scoped to this session's (studioId, clientId) at the query
    // layer; the action that marks them reviewed is similarly
    // scoped so a forged message id from another row cannot be
    // acknowledged from this session.
    getPortalMessagesForClient(session.studioId, session.clientId),
    // PR #129 (migration 0054): client replies to the visible
    // messages above. Same scope guarantee at the query layer; the
    // reply action additionally re-checks the parent message
    // (studio_id, client_id, message_id) + the current client's
    // archived_at IS NULL before inserting.
    getPortalRepliesForClient(session.studioId, session.clientId),
    // PR #134 (migration 0057): consent / e-sign foundation. Active
    // templates for this studio + the latest signature per template
    // for this client. Studios with no active templates render no
    // section; templates the client has already signed render as a
    // "Signed" badge under "Recently signed" instead of the
    // unsigned "Forms to review" block.
    getActiveConsentTemplatesForPortal(session.studioId),
    getLatestSignaturesByTemplateForPortal(
      session.studioId,
      session.clientId,
    ),
  ]);
  const unsignedConsentTemplates = consentTemplates.filter(
    (t) => !consentSignaturesByTemplate.has(t.id),
  );
  const signedConsentTemplates = consentTemplates.filter((t) =>
    consentSignaturesByTemplate.has(t.id),
  );
  const unreviewedCount = messages.filter(
    (m) => m.client_reviewed_at == null,
  ).length;
  // Group replies by parent message_id once so each <article> render
  // does not re-filter the full array. We deliberately do NOT pass
  // replies straight into the message render: an empty group is
  // valid and equivalent to "no replies yet under this message".
  const repliesByMessageId = new Map<string, typeof replies>();
  for (const r of replies) {
    const list = repliesByMessageId.get(r.message_id) ?? [];
    list.push(r);
    repliesByMessageId.set(r.message_id, list);
  }

  const { client, studio } = identity;

  // Postcare resolves from studio-level fields, the same source the
  // postcare email already reads. We deliberately do NOT pull
  // service.postcare or any practitioner-side notes; postcare is
  // studio-scoped by Chloe's design and this surface honours that.
  const postcareSections: ReadonlyArray<{
    heading: string;
    text: string;
  }> = [
    {
      heading: "Aftercare",
      text: studio.postcareAftercareText ?? "",
    },
    {
      heading: "Warning signs",
      text: studio.postcareWarningSignsText ?? "",
    },
    {
      heading: "Product recommendations",
      text: studio.postcareProductRecommendationsText ?? "",
    },
  ].filter((s) => s.text.trim().length > 0);

  const hasPreCare = preCareEntries.length > 0;
  const hasPostcare = postcareSections.length > 0;
  const showCareSection = hasPreCare || hasPostcare;

  // Contact button: rendered only when the studio has configured a
  // contact email. We never hardcode a personal address and the
  // mailto: is never built from a missing value.
  const contactEmail = studio.postcareContactEmail?.trim() || null;
  const contactSubject = `Question about my ${studio.name} appointment`;
  const contactHref = contactEmail
    ? `mailto:${contactEmail}?subject=${encodeURIComponent(contactSubject)}`
    : null;

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

          {messages.length > 0 && (
            <section className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-2">
                <h2
                  className="text-[12px] font-medium uppercase"
                  style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
                >
                  Messages from {studio.name}
                </h2>
                {unreviewedCount > 0 && (
                  <span
                    className="text-[11px] font-medium uppercase tracking-wider"
                    style={{ color: "#0A0A0A" }}
                    aria-label={`${unreviewedCount} unreviewed`}
                  >
                    {unreviewedCount} unreviewed
                  </span>
                )}
              </div>
              <ul className="flex flex-col gap-3">
                {messages.map((m) => {
                  const reviewed = m.client_reviewed_at != null;
                  const messageReplies = repliesByMessageId.get(m.id) ?? [];
                  return (
                    <li key={m.id}>
                      <article
                        className="flex flex-col gap-3 p-5"
                        style={{
                          backgroundColor: reviewed ? "#FAFAF7" : "#FFFFFF",
                          border: reviewed
                            ? "1px solid #E5E2D9"
                            : "1px solid #0A0A0A",
                        }}
                      >
                        <header className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-[15px] font-medium text-[#0A0A0A]">
                            {m.subject}
                          </p>
                          <p className="text-[12px]" style={{ color: "#6B6B6B" }}>
                            <FormattedDateTime iso={m.published_at} />
                          </p>
                        </header>
                        <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[#0A0A0A]">
                          {m.body}
                        </p>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          {reviewed ? (
                            <p
                              className="text-[12px] font-medium uppercase"
                              style={{
                                letterSpacing: "0.18em",
                                color: "#6B6B6B",
                              }}
                            >
                              Reviewed
                              {m.client_reviewed_at && (
                                <>
                                  {" · "}
                                  <FormattedDateTime
                                    iso={m.client_reviewed_at}
                                  />
                                </>
                              )}
                            </p>
                          ) : (
                            <form action={markPortalMessageReviewedAction}>
                              <input
                                type="hidden"
                                name="message_id"
                                value={m.id}
                              />
                              <button
                                type="submit"
                                className="px-5 py-2 text-[12px] font-medium uppercase"
                                style={{
                                  backgroundColor: "#0A0A0A",
                                  color: "#FAFAF7",
                                  letterSpacing: "0.1em",
                                }}
                              >
                                Mark as reviewed
                              </button>
                            </form>
                          )}
                        </div>

                        {/* PR #129. Client replies under this parent
                            message. We render the list above the
                            reply textarea so the conversation reads
                            top-down: studio's message, then client's
                            posted replies in chronological order,
                            then the input. Hidden when the message
                            has no replies AND the input is also
                            hidden (e.g. a future read-only state).
                            For v1 the input is always rendered for
                            non-archived parents. */}
                        {messageReplies.length > 0 && (
                          <ul
                            className="flex flex-col gap-2 border-t pt-3"
                            style={{ borderColor: "#E5E2D9" }}
                          >
                            {messageReplies.map((r) => (
                              <li
                                key={r.id}
                                className="flex flex-col gap-1 p-3"
                                style={{
                                  backgroundColor: "#F4F1EA",
                                  border: "1px solid #E5E2D9",
                                }}
                              >
                                <p
                                  className="text-[11px] font-medium uppercase"
                                  style={{
                                    letterSpacing: "0.18em",
                                    color: "#6B6B6B",
                                  }}
                                >
                                  Your reply
                                  {" · "}
                                  <FormattedDateTime iso={r.created_at} />
                                </p>
                                <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-[#0A0A0A]">
                                  {r.body}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}

                        <PortalReplyForm
                          messageId={m.id}
                          studioName={studio.name}
                        />
                      </article>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

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

          {/* PR #134. Consent / e-sign foundation. Unsigned active
              templates render via a client component that handles
              the read + sign drawer. The signed list below is a
              read-only summary rendered server-side. Both blocks
              omit when the studio has no active templates at all. */}
          <PortalConsentForms templates={unsignedConsentTemplates} />

          {signedConsentTemplates.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2
                className="text-[12px] font-medium uppercase"
                style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
              >
                Signed forms
              </h2>
              <ul className="flex flex-col gap-3">
                {signedConsentTemplates.map((t) => {
                  const sig = consentSignaturesByTemplate.get(t.id)!;
                  return (
                    <li
                      key={t.id}
                      className="flex flex-col gap-1 p-5"
                      style={{
                        backgroundColor: "#FAFAF7",
                        border: "1px solid #E5E2D9",
                      }}
                    >
                      <p className="text-[15px] font-medium text-[#0A0A0A]">
                        {t.title}
                      </p>
                      <p
                        className="text-[12px]"
                        style={{ color: "#6B6B6B" }}
                      >
                        Signed{" "}
                        <FormattedDateTime iso={sig.signed_at} />
                        {" · "}
                        v{sig.template_version}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {showCareSection && (
            <section className="flex flex-col gap-3">
              <h2
                className="text-[12px] font-medium uppercase"
                style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
              >
                Care instructions
              </h2>
              <p
                className="text-[14px]"
                style={{ color: "#3F3F3F" }}
              >
                Review this before and after your appointment.
              </p>

              {hasPreCare && (
                <div
                  className="flex flex-col gap-4 p-6"
                  style={{
                    backgroundColor: "#FAFAF7",
                    border: "1px solid #E5E2D9",
                  }}
                >
                  <h3
                    className="text-[12px] font-medium uppercase"
                    style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                  >
                    Before your appointment
                  </h3>
                  {preCareEntries.map((entry) => (
                    <div
                      key={entry.serviceName}
                      className="flex flex-col gap-1.5"
                    >
                      <p className="text-[14px] font-medium text-[#0A0A0A]">
                        {entry.serviceName}
                      </p>
                      <div className="flex flex-col gap-2">
                        <MarkdownLiteBlock
                          text={entry.preCareText}
                          keyPrefix={`precare-${entry.serviceName}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {hasPostcare && (
                <div
                  className="flex flex-col gap-4 p-6"
                  style={{
                    backgroundColor: "#FAFAF7",
                    border: "1px solid #E5E2D9",
                  }}
                >
                  <h3
                    className="text-[12px] font-medium uppercase"
                    style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                  >
                    After your appointment
                  </h3>
                  {postcareSections.map((s) => (
                    <div key={s.heading} className="flex flex-col gap-1.5">
                      <p className="text-[13px] font-medium text-[#0A0A0A]">
                        {s.heading}
                      </p>
                      <div className="flex flex-col gap-2">
                        <MarkdownLiteBlock
                          text={s.text}
                          keyPrefix={`postcare-${s.heading}`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {contactHref && (
            <section className="flex flex-col gap-2">
              <h2
                className="text-[12px] font-medium uppercase"
                style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
              >
                Questions
              </h2>
              <p
                className="text-[14px] leading-relaxed text-[#0A0A0A]"
              >
                Reach out to {studio.name} directly for anything else.
              </p>
              <a
                href={contactHref}
                className="self-start px-5 py-2 text-[12px] font-medium uppercase"
                style={{
                  border: "1px solid #0A0A0A",
                  color: "#0A0A0A",
                  letterSpacing: "0.1em",
                }}
              >
                Email {studio.name}
              </a>
            </section>
          )}

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
