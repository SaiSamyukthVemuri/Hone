"use client";

import { useEffect, useMemo, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { createCardSetupIntentAction } from "./payment-method-actions";

// PR #135. Portal Add card surface. The parent server component
// gates whether to render this at all (active card authorization
// must be signed; studio must have a usable Stripe connected
// account). When mounted, we:
//   1. Call the server action createCardSetupIntentAction to obtain
//      a SetupIntent client_secret + the studio's stripe_account_id.
//   2. loadStripe with the publishable key + stripeAccount option
//      so Elements posts directly to the studio's connected account.
//   3. Render PaymentElement; on submit call confirmSetup with
//      payment_method_data.type=card; Stripe redirects briefly
//      (no_redirect for v1 because we use a webhook for the actual
//      record), and the webhook later inserts client_payment_methods.
//
// client_secret is consumed only by the Stripe SDK; we never log it
// or render it in the DOM beyond what Elements requires.

type StartState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; clientSecret: string; stripeAccountId: string }
  | { kind: "error"; message: string };

export function PortalPaymentMethodForm({
  publishableKey,
}: {
  publishableKey: string;
}) {
  const [start, setStart] = useState<StartState>({ kind: "idle" });

  function onClickAddCard() {
    setStart({ kind: "starting" });
    void (async () => {
      const r = await createCardSetupIntentAction();
      if (!r.ok) {
        setStart({ kind: "error", message: r.error });
        return;
      }
      setStart({
        kind: "ready",
        clientSecret: r.clientSecret,
        stripeAccountId: r.stripeAccountId,
      });
    })();
  }

  if (start.kind === "idle") {
    return (
      <button
        type="button"
        onClick={onClickAddCard}
        className="self-start px-5 py-2 text-[12px] font-medium uppercase"
        style={{
          backgroundColor: "#0A0A0A",
          color: "#FAFAF7",
          letterSpacing: "0.1em",
        }}
      >
        Add card on file
      </button>
    );
  }

  if (start.kind === "starting") {
    return (
      <p className="text-[14px]" style={{ color: "#6B6B6B" }}>
        Preparing secure card form...
      </p>
    );
  }

  if (start.kind === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px]" style={{ color: "#A03030" }} role="alert">
          {start.message}
        </p>
        <button
          type="button"
          onClick={() => setStart({ kind: "idle" })}
          className="self-start text-[13px] underline"
          style={{ color: "#0A0A0A" }}
        >
          Try again
        </button>
      </div>
    );
  }

  // ready: mount Elements with the connected-account context.
  return (
    <StripeElementsBoundary
      publishableKey={publishableKey}
      stripeAccountId={start.stripeAccountId}
      clientSecret={start.clientSecret}
    />
  );
}

function StripeElementsBoundary({
  publishableKey,
  stripeAccountId,
  clientSecret,
}: {
  publishableKey: string;
  stripeAccountId: string;
  clientSecret: string;
}) {
  // loadStripe is async; memoise so React's re-renders don't churn
  // the underlying Stripe instance. The connected-account context
  // is set at loadStripe time via the second argument.
  const stripePromise = useMemo<Promise<StripeJs | null>>(
    () => loadStripe(publishableKey, { stripeAccount: stripeAccountId }),
    [publishableKey, stripeAccountId],
  );

  return (
    <Elements
      stripe={stripePromise}
      options={{ clientSecret, appearance: { theme: "stripe" } }}
    >
      <PaymentForm />
    </Elements>
  );
}

function PaymentForm() {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    // No-op effect; here so a future analytic / preview hook has a
    // mounting point without changing the component tree.
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);
    const { error: stripeErr } = await stripe.confirmSetup({
      elements,
      redirect: "if_required",
      // No return_url: we use the setup_intent.succeeded webhook to
      // record the card row, so there is no Hone-side page to land
      // on for 3DS-less flows. 3DS challenges that require a
      // redirect will use Stripe's hosted challenge page and bounce
      // back to the portal home, where the just-inserted row will
      // surface on the next render.
      confirmParams: {
        return_url: `${window.location.origin}/portal`,
      },
    });
    if (stripeErr) {
      setError(stripeErr.message ?? "Couldn't save the card.");
      setSubmitting(false);
      return;
    }
    setDone(true);
    setSubmitting(false);
  }

  if (done) {
    return (
      <p className="text-[14px]" style={{ color: "#0A0A0A" }} role="status">
        Card saved. It may take a moment to appear on the page.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <p className="text-[13px]" style={{ color: "#A03030" }} role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={!stripe || !elements || submitting}
        className="self-start px-5 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
        style={{
          backgroundColor: "#0A0A0A",
          color: "#FAFAF7",
          letterSpacing: "0.1em",
        }}
      >
        {submitting ? "Saving..." : "Save card on file"}
      </button>
    </form>
  );
}
