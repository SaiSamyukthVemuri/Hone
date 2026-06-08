import type { ActiveCardSummary } from "@/lib/payment-methods/queries";
import { FormattedDateTime } from "@/components/formatted-date-time";

// PR #135. Practitioner-side per-client card-on-file card. Server
// Component (no interactivity): the practitioner sees brand / last4 /
// expiry of the current card and the authorization signature
// timestamp if available. Stripe identifiers are NOT rendered.
//
// v1 has no Charge button, no Replace button, no Remove button. Card
// management lives in the portal; the practitioner profile is read-
// only.
//
// PR #158. The "No card on file." one-liner did not tell Chloe WHY a
// client had no card; she could not tell whether the client never
// completed Card authorization, signed it but never returned to add
// the card, or whether the studio had no template configured. Three
// blocked states are now distinguished here using two new props that
// the page resolves server-side from existing data:
//   * cardAuthorizationTemplateExists: studio has an active
//     card_authorization template. False when the owner has not
//     authored / activated one yet.
//   * cardAuthorizationSigned: this client has signed the template.
//     False when the template exists but the client has not yet
//     completed it in their portal.
//
// Each blocked state carries copy the practitioner can read aloud
// (or copy/paste) when telling the client what to do next.
//
// PR #170. New fourth state: cardAuthorizationOutOfDate. The client
// signed an older version of the live card_authorization template.
// The signature is preserved as a historical record (the snapshot
// is immutable), but the practitioner needs to know that the
// authorization is stale before any new card setup or live charge.
// The block appears in two contexts:
//   * No active card: dedicated "client must re-sign" block.
//   * Active card on file: a small warning subsection rendered
//     alongside the existing ActiveCardBlock so the practitioner
//     sees the card is still saved but is gated for new live work
//     until the client signs the current version.
//
// The portal-side dedicated re-sign block (PR #170, see
// app/portal/page.tsx:showCardAuthorizationOutOfDate) is what the
// client sees; this component's job is to make the same state
// visible to the practitioner.

export function PaymentMethodCard({
  clientName,
  activeCard,
  authorizationSignedAt,
  cardAuthorizationTemplateExists,
  cardAuthorizationSigned,
  cardAuthorizationOutOfDate,
}: {
  clientName: string;
  activeCard: ActiveCardSummary | null;
  // Latest card_authorization signature timestamp for the (studio,
  // client) pair, derived server-side from the same data already
  // loaded for ConsentSignaturesCard. Null when the client never
  // signed the template.
  authorizationSignedAt: string | null;
  cardAuthorizationTemplateExists: boolean;
  cardAuthorizationSigned: boolean;
  // PR #170. True when the client has a card_authorization
  // signature but at a template_version older than the current live
  // template's version. Practitioner-facing copy explains that the
  // client must re-sign in their portal before new card setup or
  // live charging can proceed. False when the client either has not
  // signed at all (handled by cardAuthorizationSigned=false) or has
  // signed at the current version.
  cardAuthorizationOutOfDate: boolean;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <div>
        <h2 className="text-sm font-medium uppercase tracking-wider text-neutral-500">
          Payment method
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          Card on file for {clientName}. Managed by the client in the
          secure portal.
        </p>
      </div>

      {activeCard != null ? (
        <>
          <ActiveCardBlock
            activeCard={activeCard}
            authorizationSignedAt={authorizationSignedAt}
          />
          {cardAuthorizationOutOfDate && <AuthorizationOutOfDateWarning />}
        </>
      ) : !cardAuthorizationTemplateExists ? (
        <NoTemplateBlock />
      ) : !cardAuthorizationSigned ? (
        <AuthorizationNotSignedBlock />
      ) : cardAuthorizationOutOfDate ? (
        <AuthorizationOutOfDateBlock />
      ) : (
        <AuthorizedButNoCardBlock />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Active card: brand / last4 / expiry + the authorization timestamp
// when available. Unchanged from PR #135.
// ---------------------------------------------------------------------------
function ActiveCardBlock({
  activeCard,
  authorizationSignedAt,
}: {
  activeCard: ActiveCardSummary;
  authorizationSignedAt: string | null;
}) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        Card on file: {activeCard.brand} ending in {activeCard.last4},
        expires {String(activeCard.expMonth).padStart(2, "0")}/
        {activeCard.expYear}
      </p>
      {authorizationSignedAt && (
        <p className="text-[11px] text-neutral-500">
          Authorization signed{" "}
          <FormattedDateTime iso={authorizationSignedAt} />
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #158. State: the studio has not authored / activated an
// active card_authorization template. Practitioner action is to wire
// up the template in Settings before any client can add a card.
// We point at the existing Consent forms settings surface (no
// invented route).
// ---------------------------------------------------------------------------
function NoTemplateBlock() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Card authorization template not configured
      </p>
      <p className="text-xs text-amber-900 dark:text-amber-200">
        Activate a card authorization consent template in Settings before
        clients can add a card on file. Online card setup uses Stripe
        SetupIntent; no charge is made when a card is added.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #158. State: studio has the template; this client has not yet
// signed it. Practitioner's action is to ask the client to open the
// portal and complete Card authorization. Mirrors the calm
// placeholder the client now sees on the portal so both sides tell
// the same story.
// ---------------------------------------------------------------------------
function AuthorizationNotSignedBlock() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Card authorization not signed
      </p>
      <p className="text-xs text-amber-900 dark:text-amber-200">
        This client cannot add a card on file yet because they have not
        signed the card authorization form. Ask the client to open
        their portal and complete Card authorization under Needs you.
        Once signed, the Add card option will appear in their portal.
        No charge is made when a card is added.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #158. State: authorization signed; no card on file. The client
// just needs to return to the portal and complete the Add card step.
// ---------------------------------------------------------------------------
function AuthorizedButNoCardBlock() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-neutral-200 bg-neutral-50 p-3 dark:border-neutral-700 dark:bg-neutral-900">
      <p className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
        Card authorization signed, but no card is on file yet.
      </p>
      <p className="text-xs text-neutral-600 dark:text-neutral-400">
        Ask the client to open the portal and add a card. No charge is
        made when a card is added.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #170. State: no active card AND client signed an older version
// of the live card_authorization template. Practitioner needs to
// know the client must re-sign the current version before any new
// card setup or fee preparation can proceed. The historical
// signature is preserved (snapshot model from migration 0057); we
// only block new live work.
// ---------------------------------------------------------------------------
function AuthorizationOutOfDateBlock() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Card authorization on file is out of date
      </p>
      <p className="text-xs text-amber-900 dark:text-amber-200">
        The client signed an older version of the card authorization.
        The studio updated the wording since then. Ask the client to
        open their portal and sign the updated card authorization.
        Until they do, the Add card option will not appear and no
        manual fee can be prepared. No charge is made when they
        re-sign.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PR #170. Inline warning rendered alongside the active card when
// the card_authorization is out of date. The card itself remains
// usable as a historical record; new live charges and SetupIntent
// (Replace card) are gated by the eligibility + SetupIntent action
// until the client re-signs. We deliberately do NOT hide the card
// summary because the historical signature is still valid as audit
// evidence; we only flag the state.
// ---------------------------------------------------------------------------
function AuthorizationOutOfDateWarning() {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
      <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
        Authorization needs re-signing
      </p>
      <p className="text-xs text-amber-900 dark:text-amber-200">
        The studio updated the card authorization wording since this
        client signed it. The card on file is preserved, but new
        live charges and Replace card are blocked until the client
        signs the updated authorization in their portal.
      </p>
    </div>
  );
}
