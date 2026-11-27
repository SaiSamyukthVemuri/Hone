import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { MarketingFooter } from "@/app/_components/MarketingFooter";
import { PortalHomeLayout } from "./PortalHomeLayout";
import { PortalIdentityUnavailable } from "./PortalIdentityUnavailable";
import { AppointmentReadFailure } from "./AppointmentReadFailure";
import { getPublishedPortalPresentation } from "@/lib/portal/presentation-server";
import { MARKETING_PALETTE as PALETTE } from "@/app/_components/marketingNav";
import { EyebrowCaption } from "@/app/_components/MarketingAtoms";
import { FormattedDateTime } from "@/components/formatted-date-time";
import { MarkdownLiteBlock } from "@/app/_components/MarkdownLiteBlock";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { PortalRebookCard } from "./PortalRebookCard";
import { horizonRangeInStudioTz } from "@/lib/booking/horizon";
import { todayInTz } from "@/lib/booking/tz";
import {
  getPortalBookableServices,
  getPortalBookingReadiness,
  getPortalBookingWindow,
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
  type PortalSignatureSummary,
  checkActiveConsentTemplatesForPortal,
  getLatestSignaturesByTemplateForPortal,
} from "@/lib/consent/queries";
import { PortalConsentForms } from "./PortalConsentForms";
import { withRenderedTemplateHash } from "@/lib/consent/template-snapshot";
import { readActiveCardForStudioClient } from "@/lib/payment-methods/queries";
import { resolveStripePublishableKey } from "@/lib/stripe/publishable-key";
import { inferStripeLivemode } from "@/lib/stripe/server";
import {
  LIVE_SAVE_CARD_NOTE,
  LIVE_SIGN_CARD_NOTE,
} from "@/lib/payments/portal-card-copy";
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

export const metadata: Metadata = { title: "Client portal", robots: { index: false, follow: false } };

export default async function PortalHomePage({ searchParams }: { searchParams?: Promise<{ view?: string | string[] }> }) {
  const session = await getCurrentPortalSession();
  if (!session) {
    redirect("/portal/login");
  }

  const identity = await getPortalIdentity(session.studioId, session.clientId).catch(() => undefined);
  if (!identity) {
    // The login page recognizes the cookie. Redirecting there would bounce this
    // client straight back here. Keep their session available for a retry.
    return <PortalIdentityUnavailable temporary={identity === undefined} />;
  }

  const [
    presentation,
    upcoming,
    intake,
    preCareEntries,
    messages,
    replies,
    consentTemplatesCheck,
    signatureRead,
  ] = await Promise.all([
    getPublishedPortalPresentation(session.studioId),
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
    checkActiveConsentTemplatesForPortal(session.studioId).catch(() => ({ status: "unavailable" as const })),
    getLatestSignaturesByTemplateForPortal(
      session.studioId,
      session.clientId,
    ).catch(() => null),
  ]);
  // A failed read is shown as such, never as "no forms"; a successful empty read still renders no section.
  const consentFormsUnavailable = consentTemplatesCheck.status === "unavailable" || signatureRead == null;
  const consentSignaturesByTemplate = signatureRead ?? new Map<string, PortalSignatureSummary>();
  const consentTemplates = consentTemplatesCheck.status === "ok" && signatureRead != null
    ? consentTemplatesCheck.templates : [];
  const unsignedConsentTemplates = consentTemplates.filter((t) => {
    const sig = consentSignaturesByTemplate.get(t.id);
    if (!sig) return true;
    // PR #170. Out-of-date card_authorization re-surfaces in the
    // Review and sign block so the existing PortalConsentForms UI
    // and createConsentSignatureAction handle the re-sign without
    // a new form path. We special-case card_authorization here
    // because that is the only form that ALSO gates a downstream
    // money-related action (Add Card / future live charges); a
    // treatment_consent or photo_consent edit by the studio does
    // not force a re-sign in v1 to avoid annoying every client
    // every time the studio tweaks wording.
    if (
      t.form_type === "card_authorization" &&
      sig.template_version !== t.version
    ) {
      return true;
    }
    return false;
  });
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
  const activeCard = await readActiveCardForStudioClient(
    session.studioId,
    session.clientId,
  ).catch(() => undefined);
  const cardAuthTemplate =
    consentTemplates.find((t) => t.form_type === "card_authorization") ??
    null;
  // PR #170. The card_authorization signature must match the CURRENT
  // live template version. A signature against a historical body
  // (e.g. the production "test" placeholder shipped before PR #170)
  // does NOT unlock the Add Card surface once an owner has updated
  // the template via Settings -> Consent forms (which bumps the
  // version via updateConsentTemplateAction's
  // existing.version + 1 rule). Three states surface in the portal:
  //
  //   cardAuthSignedCurrent  -- happy path; Add Card eligible.
  //   cardAuthOutOfDate      -- signature exists at an older version;
  //                             portal renders the dedicated re-sign
  //                             block (showCardAuthorizationOutOfDate)
  //                             AND surfaces the live template in the
  //                             unsigned-templates list so the
  //                             existing Review and sign flow handles
  //                             the re-sign without a new form path.
  //   <neither>              -- never signed; PR #158 placeholder
  //                             (showCardAuthorizationNeeded) handles
  //                             the unsigned case as before.
  //
  // The Map value carries template_version because
  // getLatestSignaturesByTemplateForPortal selects it (see
  // lib/consent/queries.ts:PortalSignatureSummary).
  const cardAuthSignatureSummary =
    cardAuthTemplate != null
      ? consentSignaturesByTemplate.get(cardAuthTemplate.id) ?? null
      : null;
  const cardAuthSignedCurrent =
    cardAuthTemplate != null &&
    cardAuthSignatureSummary != null &&
    cardAuthSignatureSummary.template_version === cardAuthTemplate.version;
  const cardAuthOutOfDate =
    cardAuthTemplate != null &&
    cardAuthSignatureSummary != null &&
    cardAuthSignatureSummary.template_version !== cardAuthTemplate.version;
  const publishableKeyResolution = resolveStripePublishableKey();
  // PR #323: the deployment mode, so client-facing card-authorization copy is
  // accurate. In test env this is false (existing "no live card" copy shows);
  // in live env (after #324) the live wording shows. NOTE (docs/16): the live
  // card-authorization wording requires legal/accounting sign-off before #324.
  const stripeLivemode = inferStripeLivemode();
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
  // unsignedConsentTemplates), AND PR #158 adds a calm placeholder
  // immediately below explaining that signing the form unlocks the
  // Add card surface. We do not surface a duplicate payment form
  // until the signature is in place.
  const showAddCardInNeedsYou =
    cardAuthTemplate != null &&
    cardAuthSignedCurrent &&
    activeCard === null &&
    publishableKeyResolution.ok;
  // PR #158. Calm "Card authorization needed before adding a card"
  // placeholder. Sits inside Needs you between the unsigned-forms
  // block and the actual Add card surface. Visible only when:
  //   * studio has an active card_authorization template, AND
  //   * this client has NOT yet signed it, AND
  //   * no active card is currently on file
  // Chloe's smoke test feedback: "I don't know how to add a card.
  // It should give you instructions." The unsigned form is already
  // listed in the Review and sign block, but a calm card-section
  // placeholder makes the implication ("sign that form to unlock
  // Add card") visually obvious and tells the client no charge
  // will be made.
  const showCardAuthorizationNeeded =
    cardAuthTemplate != null &&
    cardAuthSignatureSummary == null &&
    activeCard === null;
  // PR #170. Dedicated "card authorization was updated; please
  // re-sign" block. Distinct from showCardAuthorizationNeeded
  // (never signed) so the copy can be specific: the client did
  // sign an earlier version, the wording was updated, and they
  // need to re-sign the current version before any new card can
  // be saved or any fee can be prepared. Visible only when no
  // active card is on file; if an active card already exists,
  // the practitioner-side PaymentMethodCard surfaces the
  // out-of-date state to the owner instead (the card remains
  // usable for legacy purposes but new live charges are gated).
  const showCardAuthorizationOutOfDate =
    cardAuthOutOfDate && activeCard === null;
  // Compact informational message rendered only when payment-method
  // is relevant but cannot be added because no active template
  // exists. Avoids shouting at every client.
  const showNoPaymentTemplateNote =
    !consentFormsUnavailable && cardAuthTemplate == null && activeCard === null;
  const hasNeedsYou =
    hasIntakeAction
    || hasUnsignedForms
    || intake.kind === "unavailable"
    || consentFormsUnavailable
    || hasUnreviewedMessages
    || showAddCardInNeedsYou
    || showCardAuthorizationNeeded
    || showCardAuthorizationOutOfDate;

  // EMERG-PORTAL-REBOOK-01. Both reads are scoped by `session.studioId` — the
  // value the session resolved — and neither takes a slug, a client id or
  // anything else this page could have been handed by a browser.
  //
  // THEY ARE ADMIN-SCOPED BECAUSE THE PORTAL IS A SEPARATE REALM. Migration
  // 0173 restricts `services` SELECT to authenticated studio MEMBERS, and a
  // portal client is not one, so the RLS-bound `getActiveServices` returns an
  // EMPTY LIST here rather than an error — which is how a returning client ends
  // up shown a booking surface with nothing in it. See
  // lib/portal/queries.ts:getPortalBookableServices.
  const [rebookServices, bookingWindow, rebookBookable] = await Promise.all([
    getPortalBookableServices(session.studioId),
    getPortalBookingWindow(session.studioId),
    // The SAME public-readiness predicate the actions and the appointment
    // command enforce. Without it this page can render a booking card for a
    // studio whose every offered time the command would refuse — the card would
    // load, show times, and fail on submit. Asking here means the absence is
    // stated up front instead.
    getPortalBookingReadiness(session.studioId),
  ]);
  // NULL IS A FAILED READ, NOT AN EMPTY MENU. The two states render different
  // copy below, because "this studio offers nothing" and "we could not ask" are
  // different facts and only the first may be shown as an absence.
  const rebookReadFailed =
    rebookServices == null || bookingWindow == null || rebookBookable == null;
  const rebookTimezone = bookingWindow?.timezone ?? studio.timezone;
  const rebookHorizon = horizonRangeInStudioTz(
    rebookTimezone,
    bookingWindow?.publicBookingHorizonMonths ?? null,
  );

  const nextAppointment = upcoming?.[0] ?? null;
  const laterAppointments = upcoming?.slice(1) ?? [];

  const classicHeader = (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <EyebrowCaption>{studio.name}</EyebrowCaption>
        <h1
          className="font-[var(--font-fraunces)] mt-8 text-[36px] font-bold leading-tight md:text-[44px]"
          style={{ letterSpacing: "-0.025em" }}
        >
          Hello, {client.firstName}.
        </h1>
      </div>
      {/* PR #159 introduced this top-right cluster so the
          client can see Email + Sign out without scrolling.
          PR #166 flips the cluster from flex-col to flex-row
          because Chloe's smoke test surfaced that Sign out
          stacked BELOW Email Willow read like a secondary
          affordance of Email rather than a peer action. The
          row layout keeps both controls visibly anchored to
          the top-right corner with Sign out as the rightmost
          element. items-center keeps the underline-only Sign
          out vertically aligned with the bordered Email
          button; gap-4 matches the visual breathing room PR
          #159 used between the two controls. On narrow
          viewports the outer header still carries flex-wrap,
          so the right cluster moves below the heading
          without breaking. The Email button only renders
          when the studio has a postcare contact email on
          file (the same gate the bottom Need help block
          used before PR #159); the bottom block is gone to
          avoid duplicating the affordance. */}
      <div className="flex flex-row items-center gap-4">
        {contactHref && (
          <a
            href={contactHref}
            className="px-5 py-2 text-[12px] font-medium uppercase"
            style={{
              border: "1px solid #0A0A0A",
              color: "#0A0A0A",
              letterSpacing: "0.1em",
            }}
          >
            Email {studio.name}
          </a>
        )}
        <form action={portalLogoutAction}>
          <button
            type="submit"
            className="text-[13px] underline"
            style={{ color: "#6B6B6B" }}
          >
            Sign out
          </button>
        </form>
      </div>
    </header>
  );

  const booking = (
    <section className="flex flex-col gap-2">
      {rebookReadFailed ? (
        <p
          data-testid="portal-rebook-unavailable"
          className="text-[13px]"
          style={{ color: "#3F3F3F" }}
        >
          We couldn&rsquo;t load booking right now. Please try again in a
          moment, or contact {studio.name}.
        </p>
      ) : !rebookBookable || rebookServices.length === 0 ? (
        <p
          data-testid="portal-rebook-no-services"
          className="text-[13px]"
          style={{ color: "#3F3F3F" }}
        >
          {studio.name} isn&rsquo;t taking online bookings at the moment.
          Please contact the studio directly.
        </p>
      ) : (
        <PortalRebookCard
          services={rebookServices}
          timezone={rebookTimezone}
          minDate={todayInTz(rebookTimezone)}
          maxDate={rebookHorizon.maxDateStr}
          studioName={studio.name}
        />
      )}
    </section>
  );

  const tasks = (
    <>
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

          {intake.kind === "unavailable" && (
            <p role="status">We couldn’t check your intake just now. Reload the page to try again.</p>
          )}

          {consentFormsUnavailable && (
            <p role="status" data-testid="portal-forms-unavailable" className="text-[13px] text-[#6B6B6B]">
              We couldn’t check for forms just now. Please reload this page to try again.
            </p>
          )}

          {hasUnsignedForms && (
            <section
              id="forms-to-sign"
              className="flex flex-col gap-2 scroll-mt-20"
            >
              <p className="text-[15px] font-medium text-[#0A0A0A]">
                Review and sign forms
              </p>
              {/* PortalConsentForms is a client component that
                  handles the read-then-sign drawer inline. After
                  a successful sign the server-side
                  revalidatePath('/portal') reruns the parent so
                  the just-signed template moves out of this
                  block automatically. No duplicate card is
                  rendered lower on the page.
                  PR #158: section now carries id="forms-to-sign"
                  so the "Card authorization needed" placeholder
                  below can deep-link the client straight to the
                  signing surface via a fragment URL. */}
              <PortalConsentForms
                templates={unsignedConsentTemplates.map(
                  withRenderedTemplateHash,
                )}
              />
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

          {/* PR #158. Card authorization needed placeholder. Calm
              card-section block that explains the gating implication
              the unsigned form above carries: card-on-file is locked
              until the client signs Card authorization. Avoids the
              prior failure mode where Chloe (and by extension real
              clients) opened the portal, saw the unsigned form
              separately, and never connected the dots that signing
              it unlocks the Add card surface. Carries an explicit
              "review card authorization" link that deep-links to
              the Review and sign forms block above. */}
          {showCardAuthorizationNeeded && (
            <section id="portal-payment" className="flex flex-col gap-3">
              <p className="text-[15px] font-medium text-[#0A0A0A]">
                Card authorization needed before adding a card
              </p>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                Before you can add a card on file, please review and sign the card authorization form above.
              </p>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                Once that form is signed, the secure card form will appear here.{" "}
                {stripeLivemode
                  ? LIVE_SAVE_CARD_NOTE
                  : "No charge will be made when you add a card."}
              </p>
              <a
                href="#forms-to-sign"
                className="self-start text-[12px] font-medium uppercase"
                style={{
                  backgroundColor: "#0A0A0A",
                  color: "#FAFAF7",
                  letterSpacing: "0.1em",
                  padding: "10px 20px",
                }}
              >
                Review card authorization
              </a>
            </section>
          )}

          {/* PR #170. Dedicated "re-sign updated card
              authorization" state. Reached when the client signed
              a historical version of the card_authorization
              template and the studio has since updated the
              wording (which bumps the version via the existing
              Settings -> Consent forms edit path). The block
              intentionally names the consequence in plain terms
              ("until you sign the new version") and deep-links
              to the same #forms-to-sign anchor as the
              authorization-needed block; the card_authorization
              template is added back into unsignedConsentTemplates
              above so the existing Review and sign UI accepts
              the re-sign and lands a new signature row at the
              current version. */}
          {showCardAuthorizationOutOfDate && (
            <section id="portal-payment" className="flex flex-col gap-3">
              <p className="text-[15px] font-medium text-[#0A0A0A]">
                Card authorization was updated
              </p>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                The studio updated the card-on-file authorization. To keep using a card on file, please review and sign the new version.
              </p>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                Until you sign the new version, no new card can be added on file.{" "}
                {stripeLivemode
                  ? LIVE_SIGN_CARD_NOTE
                  : "No charge will be made when you sign or when you add a card."}
              </p>
              <a
                href="#forms-to-sign"
                className="self-start text-[12px] font-medium uppercase"
                style={{
                  backgroundColor: "#0A0A0A",
                  color: "#FAFAF7",
                  letterSpacing: "0.1em",
                  padding: "10px 20px",
                }}
              >
                Review updated authorization
              </a>
            </section>
          )}

          {showAddCardInNeedsYou && publishableKeyResolution.ok && (
            <section id="portal-payment" className="flex flex-col gap-2">
              <p className="text-[15px] font-medium text-[#0A0A0A]">
                Add payment method
              </p>
              {/* PR #158. Supporting line clarifies the state for the
                  client who just signed Card authorization and is
                  now seeing the card form appear. The "No charge"
                  reassurance mirrors the placeholder above so the
                  two surfaces tell the same story end to end. */}
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                You have signed card authorization. You can now add a card on file.{" "}
                {stripeLivemode
                  ? LIVE_SAVE_CARD_NOTE
                  : "No charge will be made when you add a card."}
              </p>
              <p
                className="text-[14px] leading-relaxed"
                style={{ color: "#3F3F3F" }}
              >
                Your card will be stored securely by Stripe. Hone does not store your full card number.
              </p>
              <PortalPaymentMethodForm
                publishableKey={publishableKeyResolution.key}
                livemode={stripeLivemode}
                studioName={studio.name}
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
    </>
  );

  const classicAppointments = (
    <section className="flex flex-col gap-2">
      <h2
        className="text-[12px] font-medium uppercase"
        style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
      >
        Appointments
      </h2>
      <section className="flex flex-col gap-2">
        <h3
          className="text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
        >
          Next appointment
        </h3>
        {upcoming === null ? (
            <AppointmentReadFailure />
          ) : nextAppointment == null ? (
          <p className="text-[15px] leading-relaxed text-[#0A0A0A]">
            No upcoming appointments
          </p>
        ) : (
          <>
            <div
              data-portal-appointment-id={nextAppointment.id}
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
                  <time dateTime={nextAppointment.startsAt}><FormattedDateTime iso={nextAppointment.startsAt} /></time>
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
                      data-portal-appointment-id={appt.id}
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
                          <time dateTime={appt.startsAt}><FormattedDateTime iso={appt.startsAt} /></time>
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
    </section>
  );

  const care = (
    <>
      {showCareSection && (
        <section className="flex flex-col gap-2">
          <h2
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
          >
            Care instructions
          </h2>
          <details open className="flex flex-col gap-2">
            <summary
              className="cursor-pointer text-[11px] font-medium uppercase"
              style={{
                letterSpacing: "0.18em",
                color: "#6B6B6B",
              }}
            >
              Review these before and after your appointment.
            </summary>
            <div className="mt-3 flex flex-col gap-3">
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
        </section>
      )}
    </>
  );

  const records = (
    <>
      {(reviewedMessages.length > 0 || signedConsentTemplates.length > 0) && (
        <section className="flex flex-col gap-5">
          <h2
            className="text-[12px] font-medium uppercase"
            style={{ letterSpacing: "0.2em", color: "#6B6B6B" }}
          >
            Forms and records
          </h2>

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
                Completed forms
              </h3>
              {/* PR #159. Chloe's smoke-test feedback: signed forms
                  looked like they were clickable, but the row had
                  no destination because there is no signed-form
                  viewer yet. Two changes:
                    * Heading renamed Signed forms -> Completed
                      forms so the row reads like a record, not a
                      link.
                    * Row styling drops the heavy border + lifts
                      the background tone so the list no longer
                      mimics the actionable Needs-you cards.
                  Caption verb changes Signed -> Completed for the
                  same reason. Photo-consent denied/granted rows
                  keep their explicit response prefix because the
                  response itself is the record. A viewable copy
                  of the signed form is a future PR; the placeholder
                  footnote at the bottom of the section sets the
                  expectation honestly without overclaiming. */}
              <ul className="flex flex-col">
                {signedConsentTemplates.map((t) => {
                  const sig = consentSignaturesByTemplate.get(t.id)!;
                  const isPhoto = t.form_type === "photo_consent";
                  const captionPrefix = isPhoto
                    ? sig.response === "denied"
                      ? "Consent denied · "
                      : "Consent granted · "
                    : "Completed ";
                  return (
                    <li
                      key={t.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 border-t py-3"
                      style={{ borderColor: "#E5E2D9" }}
                    >
                      <p className="text-[14px] text-[#0A0A0A]">
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
              <p
                className="text-[12px]"
                style={{ color: "#6B6B6B" }}
              >
                A viewable copy of signed forms is coming soon.
              </p>
            </section>
          )}
        </section>
      )}
    </>
  );

  const payment = (
    <>
      {activeCard != null ? (
        publishableKeyResolution.ok ? (
          <PortalCardOnFileCard
            card={activeCard}
            publishableKey={publishableKeyResolution.key}
            livemode={stripeLivemode}
            studioName={studio.name}
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
      ) : activeCard === undefined ? (
        <section className="flex flex-col gap-2">
          <h3>Payment method</h3>
          <p role="status">We couldn’t check your saved card. Reload this page to try again.</p>
        </section>
      ) : showNoPaymentTemplateNote ? (
        <section className="flex flex-col gap-2">
          <h3
            className="text-[11px] font-medium uppercase"
            style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
          >
            Payment method
          </h3>
          {/* PR #158. Calm State A copy: the studio has not
              enabled the card-on-file feature at all (no
              active card_authorization template exists yet).
              Distinct from the "authorization needed" placeholder
              in Needs you, which fires when the template exists
              but the client has not signed it. Wording avoids
              Stripe jargon since the client cannot act on this
              state. */}
          <p className="text-[13px]" style={{ color: "#6B6B6B" }}>
            Card setup is not available yet: the studio has not activated its card authorization form. Please contact the studio if you have a question about payment.
          </p>
        </section>
      ) : null}
    </>
  );

  if (presentation) {
    return (
      <PortalHomeLayout
        presentation={presentation}
        studioName={studio.name}
        timezone={studio.timezone}
        firstName={client.firstName}
        contactHref={contactHref}
        expiresAt={session.expiresAt}
        initialView={(await searchParams)?.view}
        upcoming={upcoming}
        formsDue={unsignedConsentTemplates.length + Number(hasIntakeAction)}
        signedFormsCount={consentFormsUnavailable ? null : signedConsentTemplates.length}
        unreadCount={unreviewedMessages.length}
        hasTasks={hasNeedsYou}
        hasCare={showCareSection}
        hasPayment={activeCard === undefined || Boolean(activeCard || cardAuthTemplate)}
        paymentUnavailable={Boolean(cardAuthTemplate && cardAuthSignedCurrent && activeCard === null && !publishableKeyResolution.ok)}
        hasHistory={Boolean(reviewedMessages.length || signedConsentTemplates.length)}
        preCare={preCareEntries}
        postCare={postcareSections}
        canBook={rebookReadFailed ? null : Boolean(rebookBookable && rebookServices.length)}
        booking={booking}
        tasks={tasks}
        records={records}
        payment={payment}
        cancellationPolicy={studio.cancellationPolicyText}
        noShowPolicy={studio.noShowPolicyText}
        paymentInTasks={showAddCardInNeedsYou || showCardAuthorizationNeeded || showCardAuthorizationOutOfDate}
      />
    );
  }

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
          {classicHeader}
          {booking}
          {tasks}
          {classicAppointments}
          {care}
          {records}
          {payment}
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
