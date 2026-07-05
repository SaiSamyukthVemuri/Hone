"use client";

import { useState } from "react";
import { PortalPaymentMethodForm } from "./PortalPaymentMethodForm";
import { TEST_MODE_CARD_NOTE } from "@/lib/payments/portal-card-copy";

// PR #151. Read-only card-on-file summary + Replace card affordance.
//
// Rendered in the portal "Your info" zone when the visitor already
// has an active card. Clicking Replace opens the existing
// PortalPaymentMethodForm in `replace` mode; the form reuses
// createCardSetupIntentAction (server-side) and the webhook's
// pre-flip + idempotency logic (set_intent.succeeded handler in
// app/api/stripe/webhook/route.ts) handles the active -> removed
// transition atomically.
//
// What this component does NOT do:
//   * No Stripe call directly. The form below handles loadStripe.
//   * No row mutation. The webhook is the only writer.
//   * No live mode. Production behavior depends on the same
//     test-mode posture every other card-on-file surface uses.

type ActiveCardSummary = {
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
};

export function PortalCardOnFileCard({
  card,
  publishableKey,
  livemode = false,
  studioName = "",
}: {
  card: ActiveCardSummary;
  // Resolved by the server-rendered portal page via
  // resolveStripePublishableKey(). Passed in only when the gate
  // returned ok; this component never renders if the gate is closed.
  publishableKey: string;
  // PR #323: deployment mode (server-computed). Gates the client-facing
  // card-authorization copy. In live mode it shows the lawyer-approved
  // authorization; in test mode the "no live card will be charged" warning.
  livemode?: boolean;
  // Studio name for the authorization copy. Falls back to "the studio".
  studioName?: string;
}) {
  const studio = studioName.trim() || "the studio";
  const [replacing, setReplacing] = useState(false);

  const summary = (
    <p className="text-[14px] text-[#0A0A0A]">
      Card on file: {card.brand} ending in {card.last4}, expires{" "}
      {String(card.expMonth).padStart(2, "0")}/{card.expYear}
    </p>
  );

  if (!replacing) {
    return (
      <section className="flex flex-col gap-3">
        <h3
          className="text-[11px] font-medium uppercase"
          style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
        >
          Payment method
        </h3>
        {summary}
        <p
          className="text-[12px] leading-[1.5]"
          style={{ color: "#6B6B6B" }}
        >
          Use this if your card expired, was replaced, or you want
          the studio to use a different card for authorized fees.
        </p>
        {livemode ? (
          <div
            className="flex flex-col gap-2 text-[12px] leading-[1.5]"
            style={{ color: "#6B6B6B" }}
          >
            <p className="font-medium text-[#0A0A0A]">
              Card-on-file authorization
            </p>
            <p>
              By saving a payment card on file, you authorize {studio} to charge
              that card for amounts you have agreed to pay under {studio}&apos;s
              booking, cancellation, no-show, and payment policies.
            </p>
            <p>These charges may include, where applicable:</p>
            <ul className="list-disc pl-5">
              <li>appointment or treatment charges you approve;</li>
              <li>no-show fees;</li>
              <li>late-cancellation fees;</li>
              <li>
                other fees that are clearly disclosed to you and authorized
                under the studio&apos;s policy.
              </li>
            </ul>
            <p>
              Your card will only be charged by {studio} for amounts that are
              permitted under the policy you agreed to. Hone is the software
              platform and is not the treatment provider or merchant of record.
            </p>
            <p>
              You may contact {studio} with any questions about charges, refunds,
              cancellation fees, or no-show fees.
            </p>
          </div>
        ) : (
          <p
            className="text-[12px] leading-[1.5]"
            style={{ color: "#6B6B6B" }}
          >
            {TEST_MODE_CARD_NOTE}
          </p>
        )}
        <button
          type="button"
          onClick={() => setReplacing(true)}
          className="self-start px-5 py-2 text-[12px] font-medium uppercase"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          Replace card
        </button>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <h3
        className="text-[11px] font-medium uppercase"
        style={{ letterSpacing: "0.18em", color: "#6B6B6B" }}
      >
        Replace card
      </h3>
      {summary}
      {/* PR #152. autoStart=true makes the inner form skip its own
          idle "Replace card" button and immediately fetch the
          SetupIntent client_secret. The outer "Replace card" button
          (above) is the single user click that drives the flow; the
          visitor previously had to click a SECOND identically-
          labelled button before Stripe Elements appeared. */}
      <PortalPaymentMethodForm
        publishableKey={publishableKey}
        livemode={livemode}
        studioName={studioName}
        mode="replace"
        autoStart
        onCancel={() => setReplacing(false)}
      />
    </section>
  );
}
