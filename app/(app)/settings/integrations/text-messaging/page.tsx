import { redirect } from "next/navigation";
import { requirePractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { PendingLink } from "@/components/pending-link";
import {
  SettingsViewHeading,
  STUDIO_WIDE_SCOPE,
} from "@/components/settings/view-heading";
import { SmsSenderStatusCard } from "../SmsSenderStatusCard";
import {
  presentSenderStatus,
  readOwnStudioSmsSender,
} from "@/lib/sms/sender-status";

// Integrations > Text-message setup. Owner-only, REPORT ONLY. Hone ships a
// complete per-studio sender lifecycle (0191/0194, provision, adopt) that no
// product path can currently reach, so a studio owner has never been able to see
// whether their studio has a sender at all. This view is that status and nothing
// more: it starts no provisioning, constructs no provider, offers no control and
// activates nothing. The read goes through the CALLER'S OWN session client,
// deliberately: 0191's owner policy and column grant decide whether a row comes
// back and which columns it carries. Which messages the studio sends is a
// separate page (Studio > Text-message preferences), linked both ways.
export default async function TextMessagingSetupPage() {
  const { practitioner, studio } = await requirePractitionerWithStudio();
  if (practitioner.role !== "owner") redirect("/settings/profile");

  const smsRead = await createClient().then((supabase) =>
    readOwnStudioSmsSender(supabase, studio.id),
  );

  return (
    <section className="flex flex-col gap-8">
      <SettingsViewHeading title="Text-message setup" scope={STUDIO_WIDE_SCOPE}>
        The sending number for {studio.name}. Which messages are sent is chosen
        under{" "}
        <PendingLink
          href="/settings/studio/text-messages"
          pendingLabel="Loading settings…"
          className="underline"
        >
          Studio &gt; Text-message preferences
        </PendingLink>
        .
      </SettingsViewHeading>
      <SmsSenderStatusCard view={presentSenderStatus(smsRead)} />
    </section>
  );
}
