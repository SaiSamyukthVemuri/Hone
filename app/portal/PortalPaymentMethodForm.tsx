"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TEST_MODE_CARD_NOTE } from "@/lib/payments/portal-card-copy";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { loadStripe, type Stripe as StripeJs } from "@stripe/stripe-js";
import { useRouter } from "next/navigation";
import {
  confirmCardPersistedAction,
  createCardSetupIntentAction,
} from "./payment-method-actions";
import {
  CONFIRM_MAX_ATTEMPTS,
  pollForCardPersistence,
} from "@/lib/payments/card-finalization";

// PR #135. Portal Add card surface. PR #151 extends it with a
// Replace card mode that surfaces in /portal when the client
// already has an active card on file.
//
// The parent server component gates whether to render this at all
// (active card authorization must be signed; studio must have a
// usable Stripe connected account). When mounted, we:
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
//
// `mode` drives COPY ONLY. The server action does not branch on it;
// it derives the client's current card state from the DB. The
// webhook handles the active/removed transition atomically (PR #135
// pre-flip + idempotency SELECT, see app/api/stripe/webhook/route.ts).
// The mode value is therefore never trusted as a security control.

type Mode = "add" | "replace";

type StartState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; clientSecret: string; stripeAccountId: string; setupIntentId: string }
  | { kind: "error"; message: string };

const COPY: Record<
  Mode,
  {
    idleButton: string;
    saveButton: string;
    saveButtonPending: string;
    // Three DISTINCT states. Stripe accepting the card is not Hone saving it.
    submittedHeadline: string;
    successHeadline: string;
    stillFinalizingHeadline: string;
    rejectedHeadline: string;
    introCopy: string | null;
    // PR #152. Copy shown while the client_secret is being fetched.
    startingHeadline: string;
    // PR #152. Generic error surfaced if the start action fails.
    startErrorMessage: string;
  }
> = {
  add: {
    idleButton: "Add card on file",
    saveButton: "Save card on file",
    saveButtonPending: "Saving...",
    submittedHeadline: "Card submitted. Finalizing with Hone...",
    successHeadline: "Card saved.",
    stillFinalizingHeadline:
      "Your card was accepted, but we have not confirmed it yet. Do not enter it again \u2014 check status again below, or contact the studio if it does not confirm.",
    rejectedHeadline:
      "Your card was accepted by our payment provider, but we could not attach it to your file. Please contact the studio \u2014 do not re-enter your card.",
    introCopy: null,
    startingHeadline: "Preparing secure card form...",
    startErrorMessage:
      "We could not open the secure card form. Please try again.",
  },
  replace: {
    idleButton: "Replace card",
    saveButton: "Save new card",
    saveButtonPending: "Saving...",
    submittedHeadline: "New card submitted. Finalizing with Hone...",
    successHeadline: "Card updated. Your new card is now on file.",
    stillFinalizingHeadline:
      "Your new card was accepted, but we have not confirmed it yet. Your existing card stays on file and remains the card we will use until the new one is confirmed. Do not enter it again \u2014 check status again below, or contact the studio.",
    rejectedHeadline:
      "Your new card was accepted by our payment provider, but we could not attach it to your file. Your previous card is unchanged. Please contact the studio \u2014 do not re-enter your card.",
    introCopy:
      `Your current card will be replaced after the new card is saved. ${TEST_MODE_CARD_NOTE}`,
    startingHeadline: "Preparing secure card form...",
    startErrorMessage:
      "We could not open the secure card form. Please try again.",
  },
};

export function PortalPaymentMethodForm({
  publishableKey,
  mode = "add",
  autoStart = false,
  onCancel,
  livemode = false,
  studioName = "",
}: {
  publishableKey: string;
  mode?: Mode;
  // PR #323: deployment mode (server-computed). Gates the "Test mode only. No
  // charge will be made." intro copy. In live mode the lawyer-approved
  // replace-card authorization is shown instead.
  livemode?: boolean;
  // Studio name for the live authorization copy. Falls back to "the studio".
  studioName?: string;
  // PR #152. When true, the form skips its own idle "click to start"
  // button and immediately triggers the start logic on mount. The
  // Replace card flow turns this on: the OUTER "Replace card" button
  // (in PortalCardOnFileCard) is the single user action; mounting
  // this component is the intent. Without autoStart the user had to
  // click a SECOND identically-labelled "Replace card" button inside
  // this form before Stripe Elements appeared, which read as "the
  // first click did nothing."
  //
  // The autoStart prop is NEVER trusted on the server. The server
  // action does not branch on it; it derives identity + state from
  // the portal session cookie + the DB. autoStart is purely a UX
  // hint that controls whether the inner idle button renders.
  autoStart?: boolean;
  // Optional Cancel handler exposed for the Replace flow so the
  // parent can collapse the form back to the card summary. Add
  // flow does not pass it (Needs You's Add panel does not need a
  // cancel affordance; the visitor can just navigate away).
  onCancel?: () => void;
}) {
  const [start, setStart] = useState<StartState>({ kind: "idle" });
  const copy = COPY[mode];
  const studio = studioName.trim() || "the studio";
  // Mode-aware replace-card intro copy. Live: lawyer-approved authorization
  // (2026-07-04). Test: the existing "No charge / test mode" wording. `add`
  // mode has no intro copy (null) in either mode.
  const introCopy =
    copy.introCopy == null
      ? null
      : livemode
        ? `Saving a new card will replace the current card on file for ${studio}. By saving this new card, you authorize ${studio} to charge it for amounts you have agreed to pay under ${studio}'s booking, cancellation, no-show, and payment policies, including approved appointment charges, no-show fees, late-cancellation fees, or other disclosed and authorized fees.`
        : copy.introCopy;

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
        setupIntentId: r.setupIntentId,
      });
    })();
  }

  // PR #152. Auto-start guard. React Strict Mode (and any future
  // remount) runs `useEffect` setup twice in development. A single
  // server action call is the contract; a SetupIntent costs Stripe
  // round-trips and the second call would produce a wasted PaymentIntent-
  // unused SetupIntent on the connected account. The ref ensures
  // exactly one start across all renders of this component instance.
  //
  // We also gate on `start.kind === "idle"` so a parent rerender that
  // toggles autoStart on after the form already started does not kick
  // off a second start.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartedRef.current) return;
    if (start.kind !== "idle") return;
    autoStartedRef.current = true;
    onClickAddCard();
    // We intentionally do NOT include `start` in deps. The effect is
    // a one-shot kickoff; the ref guard plus the start.kind check
    // above is the gate. Re-running on every state change would
    // either double-start or be redundant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // PR #152. When autoStart is on we suppress the inner idle button
  // entirely. The effect above will flip state to `starting` on the
  // next tick; in the interim we render the same "Preparing secure
  // card form..." copy the `starting` branch shows, so the visitor
  // never sees a second click target. When autoStart is off (the Add
  // card path), the idle branch renders the labelled button as before.
  if (start.kind === "idle") {
    if (autoStart) {
      return (
        <div className="flex flex-col gap-3">
          {introCopy && (
            <p
              className="text-[13px] leading-[1.5]"
              style={{ color: "#6B6B6B" }}
            >
              {introCopy}
            </p>
          )}
          <p className="text-[14px]" style={{ color: "#6B6B6B" }}>
            {copy.startingHeadline}
          </p>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="self-start text-[13px] underline"
              style={{ color: "#0A0A0A" }}
            >
              Cancel
            </button>
          )}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-3">
        {introCopy && (
          <p
            className="text-[13px] leading-[1.5]"
            style={{ color: "#6B6B6B" }}
          >
            {introCopy}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-3">
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
            {copy.idleButton}
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="self-start text-[13px] underline"
              style={{ color: "#0A0A0A" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  if (start.kind === "starting") {
    return (
      <div className="flex flex-col gap-3">
        {introCopy && (
          <p
            className="text-[13px] leading-[1.5]"
            style={{ color: "#6B6B6B" }}
          >
            {introCopy}
          </p>
        )}
        <p className="text-[14px]" style={{ color: "#6B6B6B" }}>
          {copy.startingHeadline}
        </p>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="self-start text-[13px] underline"
            style={{ color: "#0A0A0A" }}
          >
            Cancel
          </button>
        )}
      </div>
    );
  }

  if (start.kind === "error") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[13px]" style={{ color: "#A03030" }} role="alert">
          {copy.startErrorMessage}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              autoStartedRef.current = false;
              setStart({ kind: "idle" });
            }}
            className="self-start text-[13px] underline"
            style={{ color: "#0A0A0A" }}
          >
            Try again
          </button>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="self-start text-[13px] underline"
              style={{ color: "#0A0A0A" }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  }

  // ready: mount Elements with the connected-account context.
  return (
    <StripeElementsBoundary
      publishableKey={publishableKey}
      stripeAccountId={start.stripeAccountId}
      clientSecret={start.clientSecret}
      setupIntentId={start.setupIntentId}
      copy={copy}
      introCopy={introCopy}
      onCancel={onCancel}
    />
  );
}

function StripeElementsBoundary({
  publishableKey,
  stripeAccountId,
  clientSecret,
  setupIntentId,
  copy,
  introCopy,
  onCancel,
}: {
  publishableKey: string;
  stripeAccountId: string;
  clientSecret: string;
  setupIntentId: string;
  copy: (typeof COPY)[Mode];
  introCopy: string | null;
  onCancel?: () => void;
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
      <PaymentForm
        copy={copy}
        introCopy={introCopy}
        onCancel={onCancel}
        setupIntentId={setupIntentId}
      />
    </Elements>
  );
}

// The finalization state machine lives in lib/payments/card-finalization.ts so
// it can be behaviourally tested — this component cannot be rendered in the
// unit lane, and the fake-Stripe browser lane cannot drive Elements. See that
// module's header for the three bounds and why they exist.

type SubmitPhase =
  | "idle"
  | "submitting" // confirmSetup in flight
  | "finalizing" // Stripe accepted; waiting for Hone's own record
  | "saved" // Hone has an ACTIVE row for this SetupIntent
  | "notConfirmed" // accepted, not confirmed within the window — RECOVERABLE
  | "rechecking" // an explicit "Check status again" is in flight
  | "rejected"; // Hone durably refused the payload

function PaymentForm({
  copy,
  introCopy,
  onCancel,
  setupIntentId,
}: {
  copy: (typeof COPY)[Mode];
  introCopy: string | null;
  onCancel?: () => void;
  setupIntentId: string;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const [phase, setPhase] = useState<SubmitPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);
  const submitting = phase === "submitting" || phase === "finalizing";

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;
    setPhase("submitting");
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
      setPhase("idle");
      return;
    }

    // Stripe accepted. Hone has NOT saved anything yet — the webhook does that.
    // Poll Hone's own record before claiming the card is saved.
    setPhase("finalizing");
    const settled = await pollForPersistence();
    if (!cancelled.current && settled === "pending") setPhase("notConfirmed");
  }

  // Shared by the initial window and the explicit "Check status again" button.
  // NEVER mints a SetupIntent and NEVER calls confirmSetup — it only asks Hone
  // about the SetupIntent Stripe already accepted.
  async function pollForPersistence(
    attempts: number = CONFIRM_MAX_ATTEMPTS,
  ): Promise<"saved" | "rejected" | "pending"> {
    const { outcome } = await pollForCardPersistence({
      setupIntentId,
      confirm: confirmCardPersistedAction,
      attempts,
      isCancelled: () => cancelled.current,
    });
    if (cancelled.current) return "pending";
    if (outcome === "saved") {
      setPhase("saved");
      // Surface the newly authoritative card on the rest of the page.
      router.refresh();
      return "saved";
    }
    if (outcome === "rejected") {
      setPhase("rejected");
      return "rejected";
    }
    return "pending";
  }

  async function onCheckAgain() {
    setPhase("rechecking");
    // A short burst, same SetupIntent. No new card is ever submitted.
    const settled = await pollForPersistence(3);
    if (!cancelled.current && settled === "pending") setPhase("notConfirmed");
  }

  if (phase === "saved") {
    return (
      <p className="text-[14px]" style={{ color: "#0A0A0A" }} role="status">
        {copy.successHeadline}
      </p>
    );
  }

  if (phase === "notConfirmed" || phase === "rechecking") {
    // NOT a dead end. Stripe holds the card; Hone has not confirmed it yet.
    // The only offered action re-reads the SAME SetupIntent.
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[14px]" style={{ color: "#0A0A0A" }} role="status">
          {copy.stillFinalizingHeadline}
        </p>
        <button
          type="button"
          onClick={onCheckAgain}
          disabled={phase === "rechecking"}
          className="self-start px-5 py-2 text-[12px] font-medium uppercase disabled:opacity-50"
          style={{
            backgroundColor: "#0A0A0A",
            color: "#FAFAF7",
            letterSpacing: "0.1em",
          }}
        >
          {phase === "rechecking" ? "Checking..." : "Check status again"}
        </button>
      </div>
    );
  }

  if (phase === "rejected") {
    return (
      <p className="text-[14px]" style={{ color: "#A03030" }} role="alert">
        {copy.rejectedHeadline}
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      {introCopy && (
        <p
          className="text-[13px] leading-[1.5]"
          style={{ color: "#6B6B6B" }}
        >
          {introCopy}
        </p>
      )}
      <PaymentElement options={{ layout: "tabs" }} />
      {error && (
        <p className="text-[13px]" style={{ color: "#A03030" }} role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
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
          {phase === "finalizing"
            ? copy.submittedHeadline
            : submitting
              ? copy.saveButtonPending
              : copy.saveButton}
        </button>
        {onCancel && !submitting && (
          <button
            type="button"
            onClick={onCancel}
            className="self-start text-[13px] underline"
            style={{ color: "#0A0A0A" }}
          >
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
