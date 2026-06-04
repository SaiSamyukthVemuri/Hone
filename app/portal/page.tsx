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
import { getActiveCardForStudioClient } from "@/lib/payment-methods/queries";
import { resolveStripePublishableKey } from "@/lib/stripe/publishable-key";
import { PortalPaymentMethodForm } from "./PortalPaymentMethodForm";
import { PortalCardOnFileCard } from "./PortalCardOnFileCard";

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

  // PR #135. Card-on-file Phase 1 portal section gating.
  //   * activeCard:          current saved card (null = none)
  //   * cardAuthTemplate:    studio's active card_authorization
  //                          template (null = owner has not set
  //                          one up yet)
  //   * cardAuthSigned:      whether this client already signed it
  //                          at any version
  //   * publishableKey:      resolved via the gate; ok=false
  //                          surfaces the calm unavailable copy
  // We reuse consentTemplates (already loaded above) so this block
  // adds at most one DB hit for the active-card lookup.
  const activeCard = await getActiveCardForStudioClient(
    session.studioId,
    session.clientId,
  );
  const cardAuthTemplate =
    consentTemplates.find((t) => t.form_type === "card_authorization") ??
    null;
  const cardAuthSigned =
    cardAuthTemplate != null &&
    consentSignaturesByTemplate.has(cardAuthTemplate.id);
  const publishableKeyResolution = resolveStripePublishableKey();
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

  // PR #136. Two-zone information architecture. The portal is now
  // organised around "Needs you" (pending actions rendered inline)
  // and "Your info" (compact reference cards). The booleans below
  // partition the existing data shape (no new queries) so each
  // surface either is rendered inline in Needs you or appears in a
  // compact summary form in Your info. Nothing is double-rendered.
  const unreviewedMessages = messages.filter(
    (m) => m.client_reviewed_at == null,
  );
  const reviewedMessages = messages.filter(
    (m) => m.client_reviewed_at != null,
  );
  const hasIntakeAction = intake.kind === "outstanding";
  const hasUnsignedForms = unsignedConsentTemplates.length > 0;
  const hasUnreviewedMessages = unreviewedMessages.length > 0;
  // Add card surfaces in Needs you only when:
  //   * studio has an active card_authorization template, AND
  //   * this client has signed it, AND
  //   * no active card is currently on file, AND
  //   * the publishable key gate resolved to ok.
  // The "authorization not signed" state is handled by the unsigned
  // forms block above (the card_authorization template itself is in
  // unsignedConsentTemplates), so we do NOT surface a duplicate
  // payment-add prompt here.
  const showAddCardInNeedsYou =
    cardAuthTemplate != null &&
    cardAuthSigned &&
    activeCard == null &&
    publishableKeyResolution.ok;
  // Compact informational message rendered only when payment-method
  // is relevant but cannot be added because no active template
  // exists. Avoids shouting at every client.
  const showNoPaymentTemplateNote =
    cardAuthTemplate == null && activeCard == null;
  const hasNeedsYou =
    hasIntakeAction
    || hasUnsignedForms
    || hasUnreviewedMessages
    || showAddCardInNeedsYou;

  const nextAppointment = upcoming[0] ?? null;
  const laterAppointments = upcoming.slice(1);

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
                Anything you need to handle is at the top. Your
                appointments, forms, and payment method live below.
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

          {/* PR #136 zone 1: Needs you. Renders only when at least
              one pending action exists; otherwise the quiet
              "all caught up" line below stands in. Each pending
              action is rendered inline (the action itself, not a
              link to it) so there is no duplicate summary-to-detail
              navigation. Care instructions, signed forms, contact,
              and reviewed messages live in Your info below. */}
          {hasNeedsYou ? (
            <section className="flex flex-col gap-5">
              <h2
                className="text-[12px] font-medium uppercase"
                style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
              >
                Needs you
              </h2>

              {hasIntakeAction && (
                <section className="flex flex-col gap-2">
                  <p className="text-[15px] font-medium text-[#0A0A0A]">
                    Complete intake
                  </p>
                  <p
                    className="text-[14px] leading-relaxed"
                    style={{ color: "#3F3F3F" }}
                  >
                    Please complete your intake before your appointment.
                    Finishing it ahead of time helps {studio.name} prepare.
                  </p>
                  {intake.kind === "outstanding" && (
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
                  )}
                </section>
              )}

              {hasUnsignedForms && (
                <section className="flex flex-col gap-2">
                  <p className="text-[15px] font-medium text-[#0A0A0A]">
                    Review and sign forms
                  </p>
                  {/* PortalConsentForms is a client component that
                      handles the read-then-sign drawer inline. After
                      a successful sign the server-side
                      revalidatePath('/portal') reruns the parent so
                      the just-signed template moves out of this
                      block automatically. No duplicate card is
                      rendered lower on the page. */}
                  <PortalConsentForms templates={unsignedConsentTemplates} />
                </section>
              )}

              {hasUnreviewedMessages && (
                <section className="flex flex-col gap-3">
                  <p className="text-[15px] font-medium text-[#0A0A0A]">
                    Messages from {studio.name}
                  </p>
                  <ul className="flex flex-col gap-3">
                    {unreviewedMessages.map((m) => {
                      const messageReplies =
                        repliesByMessageId.get(m.id) ?? [];
                      return (
                        <li key={m.id}>
                          <article
                            className="flex flex-col gap-3 p-5"
                            style={{
                              backgroundColor: "#FFFFFF",
                              border: "1px solid #0A0A0A",
                            }}
                          >
                            <header className="flex flex-wrap items-baseline justify-between gap-2">
                              <p className="text-[15px] font-medium text-[#0A0A0A]">
                                {m.subject}
                              </p>
                              <p
                                className="text-[12px]"
                                style={{ color: "#6B6B6B" }}
                              >
                                <FormattedDateTime iso={m.published_at} />
                              </p>
                            </header>
                            <p className="whitespace-pre-wrap text-[15px] leading-relaxed text-[#0A0A0A]">
                              {m.body}
                            </p>
                            <div className="flex flex-wrap items-center justify-between gap-3">
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
                            </div>

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

              {showAddCardInNeedsYou && publishableKeyResolution.ok && (
                <section className="flex flex-col gap-2">
                  <p className="text-[15px] font-medium text-[#0A0A0A]">
                    Add payment method
                  </p>
                  <p
                    className="text-[14px] leading-relaxed"
                    style={{ color: "#3F3F3F" }}
                  >
                    Your card will be stored securely by Stripe. Hone
                    does not store your full card number.
                  </p>
                  <PortalPaymentMethodForm
                    publishableKey={publishableKeyResolution.key}
                  />
                </section>
              )}
            </section>
          ) : (
            <p
              className="text-[14px]"
              style={{ color: "#6B6B6B" }}
            >
              You&rsquo;re all caught up.
            </p>
          )}

          {/* PR #136 zone 2: Your info. Reference cards, always
              compact. Renders below the Needs-you zone whether
              that zone was visible or not. Each card here is
              read-only summary; the actionable variants live in
              Needs you above. */}
          <section className="flex flex-col gap-5">
            <h2
              className="text-[12px] font-medium uppercase"
              style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
            >
              Your info
            </h2>

            <section className="flex flex-col gap-2">
              <h3
                className="text-[11px] font-medium uppercase"
                style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
              >
                Next appointment
              </h3>
              {nextAppointment == null ? (
                <p className="text-[15px] leading-relaxed text-[#0A0A0A]">
                  No upcoming appointments
                </p>
              ) : (
                <>
                  <div
                    className="flex flex-col gap-2 p-6 sm:flex-row sm:items-baseline sm:justify-between"
                    style={{
                      backgroundColor: "#FAFAF7",
                      border: "1px solid #E5E2D9",
                    }}
                  >
                    <div className="flex flex-col gap-1 min-w-0">
                      <p className="text-[15px] font-medium text-[#0A0A0A]">
                        {nextAppointment.serviceName}
                        <span style={{ color: "#6B6B6B" }}>
                          {" · "}
                          {nextAppointment.durationMinutes} min
                        </span>
                      </p>
                      <p
                        className="text-[14px]"
                        style={{ color: "#3F3F3F" }}
                      >
                        <FormattedDateTime iso={nextAppointment.startsAt} />
                      </p>
                    </div>
                    {nextAppointment.manageToken && (
                      <Link
                        href={`/manage/${nextAppointment.manageToken}`}
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
                  </div>
                  {laterAppointments.length > 0 && (
                    <details className="text-[13px]">
                      <summary
                        className="cursor-pointer"
                        style={{ color: "#6B6B6B" }}
                      >
                        View {laterAppointments.length} more upcoming
                        {laterAppointments.length === 1
                          ? " appointment"
                          : " appointments"}
                      </summary>
                      <ul className="mt-2 flex flex-col gap-2">
                        {laterAppointments.map((appt) => (
                          <li
                            key={appt.id}
                            className="flex flex-col gap-1 p-4 sm:flex-row sm:items-baseline sm:justify-between"
                            style={{
                              backgroundColor: "#FAFAF7",
                              border: "1px solid #E5E2D9",
                            }}
                          >
                            <div className="flex flex-col gap-0.5 min-w-0">
                              <p className="text-[14px] font-medium text-[#0A0A0A]">
                                {appt.serviceName}
                                <span style={{ color: "#6B6B6B" }}>
                                  {" · "}
                                  {appt.durationMinutes} min
                                </span>
                              </p>
                              <p
                                className="text-[13px]"
                                style={{ color: "#3F3F3F" }}
                              >
                                <FormattedDateTime iso={appt.startsAt} />
                              </p>
                            </div>
                            {appt.manageToken && (
                              <Link
                                href={`/manage/${appt.manageToken}`}
                                className="self-start text-[12px] underline"
                                style={{ color: "#0A0A0A" }}
                              >
                                Manage
                              </Link>
                            )}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </>
              )}
            </section>

            {reviewedMessages.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3
                  className="text-[11px] font-medium uppercase"
                  style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                >
                  Past messages
                </h3>
                <ul className="flex flex-col gap-2">
                  {reviewedMessages.map((m) => (
                    <li
                      key={m.id}
                      className="flex flex-col gap-1 p-4"
                      style={{
                        backgroundColor: "#FAFAF7",
                        border: "1px solid #E5E2D9",
                      }}
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <p className="text-[14px] font-medium text-[#0A0A0A]">
                          {m.subject}
                        </p>
                        <p
                          className="text-[12px]"
                          style={{ color: "#6B6B6B" }}
                        >
                          <FormattedDateTime iso={m.published_at} />
                        </p>
                      </div>
                      <p
                        className="text-[11px] font-medium uppercase"
                        style={{
                          letterSpacing: "0.18em",
                          color: "#6B6B6B",
                        }}
                      >
                        Reviewed
                        {m.client_reviewed_at && (
                          <>
                            {" · "}
                            <FormattedDateTime iso={m.client_reviewed_at} />
                          </>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {signedConsentTemplates.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3
                  className="text-[11px] font-medium uppercase"
                  style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                >
                  Signed forms
                </h3>
                <ul className="flex flex-col gap-1.5">
                  {signedConsentTemplates.map((t) => {
                    const sig = consentSignaturesByTemplate.get(t.id)!;
                    // PR #137. Photo-consent rows render the
                    // explicit response (granted / denied) instead
                    // of the legacy "Signed" verb so a denied row
                    // is honestly surfaced.
                    const isPhoto = t.form_type === "photo_consent";
                    const captionPrefix = isPhoto
                      ? sig.response === "denied"
                        ? "Consent denied · "
                        : "Consent granted · "
                      : "Signed ";
                    return (
                      <li
                        key={t.id}
                        className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2"
                        style={{
                          backgroundColor: "#FAFAF7",
                          border: "1px solid #E5E2D9",
                        }}
                      >
                        <p className="text-[14px] font-medium text-[#0A0A0A]">
                          {t.title}
                        </p>
                        <p
                          className="text-[12px]"
                          style={{ color: "#6B6B6B" }}
                        >
                          {captionPrefix}
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

            {/* PR #135 / #136 / #151. Payment method block.
                The Add card surface lives in Needs you above when
                no card is on file. When a card IS on file, this
                surface shows the read-only summary AND surfaces a
                Replace card affordance (PR #151) via
                PortalCardOnFileCard. Replace reuses the existing
                SetupIntent flow; the webhook pre-flips the prior
                active row to status='removed' atomically when the
                new SetupIntent succeeds (see the webhook handler
                in app/api/stripe/webhook/route.ts). The Replace
                affordance renders only when the publishable key
                gate resolved ok; otherwise the read-only summary
                stays alone. */}
            {activeCard != null ? (
              publishableKeyResolution.ok ? (
                <PortalCardOnFileCard
                  card={activeCard}
                  publishableKey={publishableKeyResolution.key}
                />
              ) : (
                <section className="flex flex-col gap-2">
                  <h3
                    className="text-[11px] font-medium uppercase"
                    style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                  >
                    Payment method
                  </h3>
                  <p className="text-[14px] text-[#0A0A0A]">
                    Card on file: {activeCard.brand} ending in{" "}
                    {activeCard.last4}, expires{" "}
                    {String(activeCard.expMonth).padStart(2, "0")}/
                    {activeCard.expYear}
                  </p>
                </section>
              )
            ) : showNoPaymentTemplateNote ? (
              <section className="flex flex-col gap-2">
                <h3
                  className="text-[11px] font-medium uppercase"
                  style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                >
                  Payment method
                </h3>
                <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
                  Card-on-file authorization is not configured yet.
                  Please contact the studio.
                </p>
              </section>
            ) : null}

            {showCareSection && (
              <details className="flex flex-col gap-2">
                <summary
                  className="cursor-pointer text-[11px] font-medium uppercase"
                  style={{
                    letterSpacing: "0.18em",
                    color: "#6B6B6B",
                  }}
                >
                  Care instructions
                </summary>
                <div className="mt-3 flex flex-col gap-3">
                  <p
                    className="text-[13px]"
                    style={{ color: "#3F3F3F" }}
                  >
                    Review this before and after your appointment.
                  </p>

                  {hasPreCare && (
                    <div
                      className="flex flex-col gap-4 p-5"
                      style={{
                        backgroundColor: "#FAFAF7",
                        border: "1px solid #E5E2D9",
                      }}
                    >
                      <h4
                        className="text-[11px] font-medium uppercase"
                        style={{
                          letterSpacing: "0.18em",
                          color: "#6B6B6B",
                        }}
                      >
                        Before your appointment
                      </h4>
                      {preCareEntries.map((entry) => (
                        <div
                          key={entry.serviceName}
                          className="flex flex-col gap-1.5"
                        >
                          <p className="text-[13px] font-medium text-[#0A0A0A]">
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
                      className="flex flex-col gap-4 p-5"
                      style={{
                        backgroundColor: "#FAFAF7",
                        border: "1px solid #E5E2D9",
                      }}
                    >
                      <h4
                        className="text-[11px] font-medium uppercase"
                        style={{
                          letterSpacing: "0.18em",
                          color: "#6B6B6B",
                        }}
                      >
                        After your appointment
                      </h4>
                      {postcareSections.map((s) => (
                        <div
                          key={s.heading}
                          className="flex flex-col gap-1.5"
                        >
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
                </div>
              </details>
            )}

            {contactHref && (
              <section className="flex flex-col gap-2">
                <h3
                  className="text-[11px] font-medium uppercase"
                  style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
                >
                  Need help?
                </h3>
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
          </section>

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
