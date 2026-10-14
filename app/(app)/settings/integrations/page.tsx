import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { GoogleCalendarCard } from "../profile/GoogleCalendarCard";
import { getOwnConnectionReadiness } from "@/lib/google-calendar/connection";
import { SmsSenderStatusCard } from "./SmsSenderStatusCard";
import { SmsSenderReadinessPanel } from "./SmsSenderReadinessPanel";
import { SmsSenderControlsSection } from "./SmsSenderControlsSection";
import { senderControlsGate, senderRecoveryFor } from "@/lib/sms/sender-controls";
import { studioSenderReadiness } from "@/lib/sms/sender-readiness";
import {
  readOwnSenderRegistrations,
  registrationEvidenceFor,
} from "@/lib/sms/sender-registration";
import {
  presentSenderStatus,
  readOwnStudioSmsSender,
} from "@/lib/sms/sender-status";

// Settings → Integrations. Owner-only surface for connecting the studio to outside
// services. Today: Google Calendar (connection + status only). This page REUSES
// the audited Google Calendar OAuth/connection engine (lib/google-calendar/*) and
// the existing GoogleCalendarCard: it adds no event sync and touches no worker,
// outbound flag, outbox, or calendar link. Synchronization stays OFF.
//
// Authorization is server-derived and defense-in-depth: this page redirects
// non-owners, the nav entry is owner-only, and every underlying server action
// re-authorizes (active practitioner + studio flag) and never trusts a browser id.

export default async function IntegrationsSettingsPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();

  // Owner-only. Non-owners are sent to their profile (where the per-practitioner
  // connection card lives). Direct-URL access by a non-owner never renders here.
  if (practitioner.role !== "owner") redirect("/settings/profile");

  // The card renders ONLY when the studio connection flag is on; when it's off the
  // card is hidden and the server actions reject anyway.
  const googleEnabled = studio.google_calendar_connection_enabled === true;

  // Both reads depend only on identity, which is already resolved, so they go
  // in one wave rather than two serial round trips.
  //
  // The SMS read goes through the CALLER'S OWN session client, deliberately:
  // 0191's owner policy and column grant are what decide whether a row comes
  // back and which columns it carries. Handing this a service-role client would
  // move that decision out of the database and into this page.
  const supabase = await createClient();
  const [google, smsRead] = await Promise.all([
    googleEnabled
      ? getOwnConnectionReadiness(studio.id, practitioner.id)
      : Promise.resolve({ metadata: null, readiness: "disconnected" as const }),
    readOwnStudioSmsSender(supabase, studio.id),
  ]);

  // SMS-SENDER-REG-01: the live sender's recorded US registration (0217),
  // through the same session client and the same owner-only policy shape.
  const sender = smsRead.ok ? smsRead.sender : null;
  const usRegistration = sender
    ? registrationEvidenceFor(
        await readOwnSenderRegistrations(supabase, sender.id),
        sender.phone_number,
      )
    : ({ state: "not_recorded" } as const);

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-medium">Integrations</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Connect {studio.name} to outside services. Only the studio owner can
          manage these connections.
        </p>
      </div>

      {/* Dormancy banner: synchronization is OFF. Do not imply appointments sync. */}
      <div
        role="note"
        data-testid="integrations-sync-off"
        className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200"
      >
        Calendar synchronization is currently off. Connecting does not create or
        change calendar events.
      </div>

      {googleEnabled ? (
        <GoogleCalendarCard
          connection={google.metadata}
          readiness={google.readiness}
          isOwner
          returnPath="/settings/integrations"
        />
      ) : (
        <div className="rounded-lg border border-neutral-300 p-5 dark:border-neutral-700">
          <h3 className="text-sm font-semibold">Google Calendar</h3>
          <p className="mt-1 text-sm text-neutral-500">
            The Google Calendar integration is not enabled for this studio yet.
          </p>
        </div>
      )}

      {/* SMS sender status — REPORT ONLY. Hone ships a complete per-studio
          sender lifecycle (0191/0194, provision, adopt) that no product path
          can currently reach, so a studio owner has never been able to see
          whether their studio has a sender at all. This card is that view and
          nothing more: it starts no provisioning, constructs no provider, and
          offers no control. */}
      <SmsSenderStatusCard view={presentSenderStatus(smsRead)} />
      {/* SMS-SENDER-READY-01 / SMS-SENDER-REG-01: the same read, per
          recipient country, with the US registration evidence support has
          recorded (none means "Requires information"). */}
      <SmsSenderReadinessPanel rows={studioSenderReadiness(smsRead, usRegistration)} />

      {/* SMS-SENDER-CONTROL-01: owner controls, FAKE PROVIDER ONLY. The gate
          is shut in production, on hosted previews and whenever live provisioning is armed, so
          nothing renders there; each action re-checks it. */}
      {senderControlsGate().open ? (
        <SmsSenderControlsSection
          studioId={studio.id}
          recovery={senderRecoveryFor(sender?.status, sender?.last_error_code)}
        />
      ) : null}
    </section>
  );
}
