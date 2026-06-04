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

export function PaymentMethodCard({
  clientName,
  activeCard,
  authorizationSignedAt,
}: {
  clientName: string;
  activeCard: ActiveCardSummary | null;
  // Latest card_authorization signature timestamp for the (studio,
  // client) pair, derived server-side from the same data already
  // loaded for ConsentSignaturesCard. Null when the client never
  // signed the template.
  authorizationSignedAt: string | null;
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
      ) : (
        <p className="text-xs italic text-neutral-500">No card on file.</p>
      )}
    </section>
  );
}
