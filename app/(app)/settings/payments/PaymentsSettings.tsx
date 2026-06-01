"use client";

// Client component that wraps the Stripe Connect settings UI.
// Server actions surface generic errors; this component renders them
// in a small status panel.
//
// Phase 1 scope: this page only manages Stripe Connect onboarding +
// account status display. It does NOT collect cards, create
// PaymentIntents, set up SetupIntents, open Checkout, save cards, or
// flip require_card_on_file. The copy here must keep that clear.

import { useTransition, useState } from "react";
import { useRouter } from "next/navigation";
import {
  startStripeConnectOnboardingAction,
  refreshStripeStatusAction,
  openStripeDashboardAction,
} from "./actions";

export type StripeStatusView = {
  accountStatus: "not_connected" | "pending" | "restricted" | "enabled" | "rejected";
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  onboardingCompletedAt: string | null;
  livemode: boolean | null;
};

export type PaymentsSettingsProps = {
  status: StripeStatusView;
  // Count of active services with positive price_cents. Used by the
  // C1 readiness card only. Not a card-collection gate. Free
  // consultations are intentionally not counted because the product
  // rule is that they remain card-free.
  paidServiceCount: number;
  // C2a-core: readiness booleans for the cancellation / no-show
  // policy row. Only the booleans cross the wire; the policy text
  // itself is rendered in Settings → Intake & Postcare.
  hasCancellationPolicy: boolean;
  hasNoShowPolicy: boolean;
};

// Plain-English status headline + supporting note. Owners shouldn't
// need to translate Stripe terminology to understand where they
// stand.
function statusCopy(status: StripeStatusView): {
  headline: string;
  detail: string;
} {
  switch (status.accountStatus) {
    case "not_connected":
      return {
        headline: "Not connected to Stripe yet",
        detail:
          "Connect your studio to Stripe to prepare for accepting payments. Setup takes a few minutes.",
      };
    case "pending":
      return {
        headline: "Stripe is reviewing your information",
        detail:
          "Stripe usually finishes verification in a few minutes. Refresh to check.",
      };
    case "restricted":
      return {
        headline: "Stripe needs a bit more information",
        detail:
          "A few details are still missing. Continue onboarding or open Stripe to finish bank and verification details.",
      };
    case "enabled":
      return {
        headline: "Connected to Stripe",
        detail:
          "Your studio is set up in Stripe. Public booking still doesn't ask clients for a card. We'll let you know before that changes.",
      };
    case "rejected":
      return {
        headline: "Stripe declined this connection",
        detail:
          "Open Stripe for the specific reason and any next steps.",
      };
  }
}

export function PaymentsSettings({
  status,
  paidServiceCount,
  hasCancellationPolicy,
  hasNoShowPolicy,
}: PaymentsSettingsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  function onConnect() {
    setError(null);
    setHint(null);
    startTransition(async () => {
      try {
        // The server action issues a redirect(); under the server-action
        // flow Next will throw a redirect signal that propagates here.
        await startStripeConnectOnboardingAction();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not start onboarding.";
        // NEXT_REDIRECT is the internal signal Next throws to perform
        // server-action redirects; let it bubble so the navigation
        // actually happens.
        if (typeof message === "string" && message.includes("NEXT_REDIRECT")) {
          throw err;
        }
        setError(message);
      }
    });
  }

  function onRefresh() {
    setError(null);
    setHint(null);
    startTransition(async () => {
      const r = await refreshStripeStatusAction();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setHint("Status refreshed from Stripe.");
      router.refresh();
      window.setTimeout(() => setHint(null), 2500);
    });
  }

  function onDashboard() {
    setError(null);
    setHint(null);
    startTransition(async () => {
      try {
        await openStripeDashboardAction();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Could not open dashboard.";
        if (typeof message === "string" && message.includes("NEXT_REDIRECT")) {
          throw err;
        }
        setError(message);
      }
    });
  }

  const connected = status.accountStatus !== "not_connected";
  const connectLabel = connected
    ? "Continue Stripe setup"
    : "Connect with Stripe";
  const dashboardEnabled = status.chargesEnabled || status.payoutsEnabled;
  const copy = statusCopy(status);

  // Banner shown above the status card whenever Hone is not yet
  // collecting from clients. Phase 1 is unconditionally non-live
  // for client booking, so this banner shows whenever the account
  // is not on live mode — which is every Phase 1 environment.
  const showTestBanner = status.livemode !== true;

  return (
    <div className="flex flex-col gap-4">
      {showTestBanner && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950/30">
          <p className="text-sm font-medium text-amber-900 dark:text-amber-100">
            Test mode: not collecting payments from clients yet
          </p>
          <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-100/80">
            Stripe setup here is for testing. Public booking still does
            not ask clients for a card. We&apos;ll let you know before
            that changes.
          </p>
        </div>
      )}

      <section className="flex flex-col gap-5 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
        <header className="flex flex-col gap-1">
          <h3 className="text-base font-medium">Stripe connection</h3>
          <p className="text-sm text-neutral-700 dark:text-neutral-300">
            <span className="font-medium">{copy.headline}.</span>{" "}
            <span className="text-neutral-600 dark:text-neutral-400">
              {copy.detail}
            </span>
          </p>
        </header>

        <ul className="flex flex-col gap-2 text-sm">
          <ReadinessItem
            ok={status.chargesEnabled}
            okLabel="Stripe can accept test payments for this studio"
            notYetLabel="Stripe cannot accept payments for this studio yet"
          />
          <ReadinessItem
            ok={status.payoutsEnabled}
            okLabel="Payouts are ready"
            notYetLabel="Payout setup still needs attention"
          />
          <ReadinessItem
            ok={status.onboardingCompletedAt != null}
            okLabel="Stripe setup completed"
            notYetLabel="Stripe setup not finished yet"
          />
        </ul>

        {status.accountStatus === "restricted" && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/30">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              Stripe needs more information
            </p>
            <p className="mt-1 text-amber-900/80 dark:text-amber-100/80">
              Continue onboarding to provide the missing details, or open
              Stripe to finish bank and verification info.
            </p>
          </div>
        )}

        {!status.payoutsEnabled && status.accountStatus !== "not_connected" && (
          <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-sm dark:border-neutral-700 dark:bg-neutral-900">
            <p className="font-medium">Payout setup is not complete yet</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">
              Continue onboarding to provide bank details, or open Stripe
              to finish payout setup. Without this, money cannot be
              transferred to your studio&apos;s bank account.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onConnect}
            disabled={pending}
            className="rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white dark:bg-white dark:text-neutral-950"
          >
            {connectLabel}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            disabled={pending || !connected}
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Refresh Stripe status
          </button>
          <button
            type="button"
            onClick={onDashboard}
            disabled={pending || !dashboardEnabled}
            title={
              dashboardEnabled
                ? "Open the Stripe Express dashboard for this studio."
                : "Available after Stripe setup completes."
            }
            className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Open Stripe dashboard
          </button>
        </div>

        <div className="flex min-h-[1.25rem] items-center gap-3 text-xs">
          {hint && (
            <span className="text-green-600 dark:text-green-400">{hint}</span>
          )}
          {error && <span className="text-red-700">{error}</span>}
        </div>
      </section>

      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-4 text-sm dark:border-neutral-800 dark:bg-neutral-900/50">
        <p className="font-medium">
          Client payments are not enabled in Hone yet.
        </p>
        <p className="mt-1 text-neutral-600 dark:text-neutral-400">
          This page does not turn on card-on-file booking. Public booking
          continues to work without a card step. Connecting Stripe here
          prepares your studio for accepting payments in a future update.
        </p>
      </div>

      <CardOnFileReadiness
        connectComplete={
          status.chargesEnabled && status.onboardingCompletedAt != null
        }
        paidServiceCount={paidServiceCount}
        livemode={status.livemode}
        hasCancellationPolicy={hasCancellationPolicy}
        hasNoShowPolicy={hasNoShowPolicy}
      />

      <details className="text-xs text-neutral-500">
        <summary className="cursor-pointer select-none">
          Technical details
        </summary>
        <dl className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="Account status">
            <code className="font-mono">{status.accountStatus}</code>
          </Field>
          <Field label="Charges enabled">
            <code className="font-mono">
              {status.chargesEnabled ? "true" : "false"}
            </code>
          </Field>
          <Field label="Payouts enabled">
            <code className="font-mono">
              {status.payoutsEnabled ? "true" : "false"}
            </code>
          </Field>
          <Field label="Mode">
            <code className="font-mono">
              {status.livemode === null
                ? "n/a"
                : status.livemode
                  ? "live"
                  : "test"}
            </code>
          </Field>
          <Field label="Onboarding completed at">
            <code className="font-mono">
              {status.onboardingCompletedAt
                ? new Date(status.onboardingCompletedAt).toLocaleString()
                : "-"}
            </code>
          </Field>
        </dl>
      </details>
    </div>
  );
}

function ReadinessItem({
  ok,
  okLabel,
  notYetLabel,
}: {
  ok: boolean;
  okLabel: string;
  notYetLabel: string;
}) {
  return (
    <li className="flex items-start gap-2">
      <span
        aria-hidden
        className={`mt-0.5 inline-flex h-4 w-4 flex-none items-center justify-center rounded-full text-[10px] font-bold ${
          ok
            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
            : "bg-neutral-200 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400"
        }`}
      >
        {ok ? "✓" : "·"}
      </span>
      <span
        className={
          ok
            ? "text-neutral-800 dark:text-neutral-200"
            : "text-neutral-500 dark:text-neutral-400"
        }
      >
        {ok ? okLabel : notYetLabel}
      </span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[11px] uppercase tracking-wider text-neutral-500">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

// Card-on-file readiness card (C1). Read-only. Purpose: make
// prerequisites visible so studio owners can finish setup steps
// they control while card collection itself remains off.
//
// This card does NOT collect cards, save cards, create SetupIntents
// or PaymentIntents, open Checkout, or change require_card_on_file.
// It exposes no enable toggle. Status is always "Not enabled".
//
// The CTAs are read-only / navigational: review services, or read
// the Connect status above. No "Enable", no "Save card", no
// "Require card".
function CardOnFileReadiness({
  connectComplete,
  paidServiceCount,
  livemode,
  hasCancellationPolicy,
  hasNoShowPolicy,
}: {
  connectComplete: boolean;
  paidServiceCount: number;
  livemode: boolean | null;
  hasCancellationPolicy: boolean;
  hasNoShowPolicy: boolean;
}) {
  const hasPaidService = paidServiceCount > 0;
  const hasBothPolicies = hasCancellationPolicy && hasNoShowPolicy;
  // Mode display: anything other than explicit `true` is treated as
  // test mode for this card. Phase 1 environments are unconditionally
  // test mode for client booking; livemode === true would represent
  // an unexpected configuration we do not currently support.
  const isTestMode = livemode !== true;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-base font-medium">Card-on-file readiness</h3>
          <span className="rounded-full bg-neutral-200 px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
            Not enabled
          </span>
        </div>
        <p className="text-sm text-neutral-700 dark:text-neutral-300">
          Card collection is not enabled yet. No cards are being collected.
          This checklist prepares your studio for a later test-mode
          card-on-file flow.
        </p>
      </header>

      <ul className="flex flex-col gap-2 text-sm">
        <ReadinessItem
          ok={connectComplete}
          okLabel="Stripe Connect connected"
          notYetLabel="Stripe Connect not finished; see Stripe connection above"
        />
        <ReadinessItem
          ok={hasPaidService}
          okLabel={
            paidServiceCount === 1
              ? "1 paid service exists"
              : `${paidServiceCount} paid services exist`
          }
          notYetLabel="No paid services configured yet"
        />
        <ReadinessItem
          ok={true}
          okLabel="Free consultations remain card-free"
          notYetLabel="Free consultations remain card-free"
        />
        <ReadinessItem
          ok={hasBothPolicies}
          okLabel="Cancellation and no-show policy on file"
          notYetLabel={
            !hasCancellationPolicy && !hasNoShowPolicy
              ? "Cancellation and no-show policy needed before collecting cards later"
              : !hasCancellationPolicy
                ? "Cancellation policy still missing; no-show policy on file"
                : "No-show policy still missing; cancellation policy on file"
          }
        />
        <ReadinessItem
          ok={isTestMode}
          okLabel="Test mode only"
          notYetLabel="Test mode only (live mode is not enabled)"
        />
        <ReadinessItem
          ok={false}
          okLabel="Card collection enabled"
          notYetLabel="Card collection not enabled"
        />
      </ul>

      <div className="rounded-md border border-neutral-200 bg-neutral-50 p-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        <p>
          When card-on-file becomes available, it will only apply to
          paid services. Free consultations will keep working with no
          card step. Hone will not charge clients at booking. No-show
          or cancellation fee charging is not part of this release.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <a
          href="/settings/services"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Review services
        </a>
        <a
          href="/settings/intake"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Edit cancellation / no-show policy
        </a>
        <a
          href="mailto:support@hone.care?subject=Card-on-file%20questions"
          className="rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Contact support
        </a>
      </div>
    </section>
  );
}
