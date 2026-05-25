"use client";

// Client component that wraps the Stripe Connect settings buttons.
// Server actions surface generic errors; this component renders them
// in a small status panel.

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
};

const STATUS_LABEL: Record<StripeStatusView["accountStatus"], string> = {
  not_connected: "Not connected",
  pending: "Pending verification",
  restricted: "Onboarding incomplete",
  enabled: "Connected — charges enabled",
  rejected: "Rejected by Stripe",
};

export function PaymentsSettings({ status }: PaymentsSettingsProps) {
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
  const connectLabel = connected ? "Continue Stripe onboarding" : "Connect with Stripe";
  const dashboardEnabled = status.chargesEnabled || status.payoutsEnabled;

  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Stripe Connect</h2>
        <p className="text-sm text-neutral-500">
          Connect your studio to Stripe to accept card payments. This
          page only manages onboarding status; card-on-file requirements
          for client bookings are not enabled by this build.
        </p>
      </header>

      <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
        <Field label="Account">
          <span className="font-medium">{STATUS_LABEL[status.accountStatus]}</span>
        </Field>
        <Field label="Charges enabled">
          <Badge ok={status.chargesEnabled} />
        </Field>
        <Field label="Payouts enabled">
          <Badge ok={status.payoutsEnabled} />
        </Field>
        <Field label="Mode">
          {status.livemode === null
            ? "Not yet connected"
            : status.livemode
              ? "Live"
              : "Test"}
        </Field>
        <Field label="Onboarding completed">
          {status.onboardingCompletedAt
            ? new Date(status.onboardingCompletedAt).toLocaleString()
            : "Not yet"}
        </Field>
      </dl>

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
              : "Available after Stripe onboarding completes."
          }
          className="rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Open Stripe dashboard
        </button>
      </div>

      <div className="flex min-h-[1.25rem] items-center gap-3 text-xs">
        {hint && <span className="text-green-600 dark:text-green-400">{hint}</span>}
        {error && <span className="text-red-700">{error}</span>}
      </div>

      <p className="text-xs text-neutral-500">
        Card-on-file booking is currently disabled. Connecting Stripe
        here unlocks the studio for live charges later; it does not
        change the public booking flow yet.
      </p>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Badge({ ok }: { ok: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        ok
          ? "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300"
          : "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      }`}
    >
      {ok ? "Yes" : "No"}
    </span>
  );
}
