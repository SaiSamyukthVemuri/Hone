import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getPractitionersForStudio, requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { getNewClientReadiness, type NewClientReadiness } from "@/lib/booking/new-client-readiness";
import { presentSenderStatus, readOwnStudioSmsSender } from "@/lib/sms/sender-status";
import { deriveConnectCapability } from "@/lib/payments/payment-status-presenter";
import { inferStripeLivemode } from "@/lib/stripe/server";
import {
  bookingPanel,
  notYetAvailablePanel,
  paymentsPanel,
  phonePanel,
  teamPanel,
  type ConsolePanel,
} from "@/lib/owner-console/summary";

// STUDIO-READY-03a (#824): the studio owner console. It covers the SELECTED
// studio only and is for its owner only.
//
// It aggregates and duplicates nothing: each panel asks the module that already
// owns its truth, and links to the page where it is changed. Reads never call
// a provider; they are durable rows only. A read that fails renders as UNKNOWN,
// never as ready (contract §3).
export const dynamic = "force-dynamic";

const TONE_PILL: Record<ConsolePanel["tone"], string> = {
  ready: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  attention: "bg-amber-50 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  unknown: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  unavailable: "border border-dashed border-neutral-300 text-neutral-500 dark:border-neutral-700",
};

export default async function OwnerConsolePage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return (
      <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
        Only studio owners can see the studio overview.
      </div>
    );
  }

  const supabase = await createClient();
  const [readiness, practitioners, pending, sender, payment] = await Promise.all([
    getNewClientReadiness(studio).then(
      (r): NewClientReadiness | null => r,
      () => null,
    ),
    getPractitionersForStudio(studio.id).then(
      (rows) => rows.length,
      () => null,
    ),
    supabase
      .from("pending_invitations")
      .select("id", { count: "exact", head: true })
      .eq("studio_id", studio.id)
      .eq("status", "pending")
      .then((r) => (r.error ? null : (r.count ?? 0))),
    readOwnStudioSmsSender(supabase, studio.id),
    supabase.rpc("get_studio_payment_settings_display", {
      p_studio_id: studio.id,
      p_stripe_livemode: inferStripeLivemode(),
    }),
  ]);

  const paymentRow = Array.isArray(payment.data) ? payment.data[0] : payment.data;
  const capability = deriveConnectCapability(
    payment.error
      ? undefined // a read error is "unknown", never an all-clear
      : paymentRow
        ? {
            accountStatus: paymentRow.account_status ?? null,
            chargesEnabled: paymentRow.charges_enabled === true,
            payoutsEnabled: paymentRow.payouts_enabled === true,
          }
        : null,
  );

  const panels: ConsolePanel[] = [
    bookingPanel(readiness),
    teamPanel(practitioners == null || pending == null ? null : { practitioners, pendingInvitations: pending }),
    phonePanel(presentSenderStatus(sender)),
    paymentsPanel(capability),
    notYetAvailablePanel("delivery"),
    notYetAvailablePanel("notifications"),
  ];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Studio overview</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Where {studio.name} stands: setup, team, messages and payments. Each item links to where it is changed.
        </p>
      </div>
      <ul className="divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {panels.map((p) => (
          <li key={p.key} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{p.title}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_PILL[p.tone]}`}>{p.status}</span>
              </div>
              <p className="mt-1 text-sm text-neutral-500">{p.detail}</p>
            </div>
            {p.href && (
              <Link href={p.href} className="shrink-0 text-sm underline-offset-4 hover:underline">
                Open
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
