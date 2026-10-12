"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  runSenderAdoption,
  runSenderProvision,
  runSenderSearch,
  senderControlsFakeProvider,
  senderControlsGate,
  type SearchResult,
} from "@/lib/sms/sender-controls";

// SMS-SENDER-CONTROL-01 (#824): the owner's sender controls. FAKE PROVIDER
// ONLY: every action re-checks the gate (never in production, never with live
// provisioning armed, only in the explicit fake mode) and passes the
// process-wide FAKE provider explicitly. It never resolves a provider, so no
// path here can reach the Twilio adapter, buy a number or send a real text.
// The fake is the controls' own, seeded with a demo account inventory so that
// adoption can succeed (lib/sms/sender-controls.ts, Codex P2 4250699100).

/** A synthetic destination for the fake provider's provisioning proof. */
const FAKE_TEST_DESTINATION = "+14165550199";

export type SenderControlResult = { ok: boolean; message: string };

async function ownerContext(): Promise<
  { ok: true; studioId: string; actorUserId: string } | { ok: false; message: string }
> {
  const gate = senderControlsGate();
  if (!gate.open) return { ok: false, message: `Studio number controls are not available here (${gate.reason}).` };
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner" || !practitioner.user_id) {
    return { ok: false, message: "Only the studio owner can manage the studio number." };
  }
  return { ok: true, studioId: studio.id, actorUserId: practitioner.user_id };
}

/** The owner-facing words for a refusal reason. */
function refusal(reason: string, country: string): string {
  if (reason === "number_country_mismatch" || reason === "area_code_country_mismatch") {
    const name = country === "US" ? "a United States" : "a Canadian";
    return `That is not ${name} number. Choose a number in the country selected.`;
  }
  if (reason === "webhook_base_unusable") return "Hone's webhook address is not configured, so no number can be set up here yet";
  return reason;
}

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v.trim() : "";
};

export async function searchSenderNumbersAction(
  _prev: SearchResult | null,
  formData: FormData,
): Promise<SearchResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, reason: ctx.message };
  return runSenderSearch(
    { provider: senderControlsFakeProvider(getRequiredAppOrigin()) },
    { country: str(formData, "country"), areaCode: str(formData, "area_code") || null },
  );
}

export async function provisionSenderNumberAction(
  _prev: SenderControlResult | null,
  formData: FormData,
): Promise<SenderControlResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, message: ctx.message };
  const out = await runSenderProvision(
    { admin: createAdminClient(), provider: senderControlsFakeProvider(getRequiredAppOrigin()), appOrigin: getRequiredAppOrigin(), testDestination: FAKE_TEST_DESTINATION },
    {
      studioId: ctx.studioId,
      actorUserId: ctx.actorUserId,
      country: str(formData, "country"),
      areaCode: str(formData, "area_code") || null,
      phoneNumber: str(formData, "phone_number"),
    },
  );
  revalidatePath("/settings/integrations");
  return out.ok
    ? { ok: true, message: out.result === "activated" ? `Studio number ${out.phoneNumber} is set up (fake provider).` : "This studio already has an active number." }
    : { ok: false, message: `Not set up: ${"reason" in out ? refusal(String(out.reason), str(formData, "country")) : out.result}.` };
}

export async function adoptSenderNumberAction(
  _prev: SenderControlResult | null,
  formData: FormData,
): Promise<SenderControlResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, message: ctx.message };
  const out = await runSenderAdoption(
    { admin: createAdminClient(), provider: senderControlsFakeProvider(getRequiredAppOrigin()), appOrigin: getRequiredAppOrigin(), testDestination: FAKE_TEST_DESTINATION },
    {
      studioId: ctx.studioId,
      actorUserId: ctx.actorUserId,
      country: str(formData, "country"),
      phoneNumber: str(formData, "phone_number"),
      messagingServiceSid: str(formData, "messaging_service_sid"),
    },
  );
  revalidatePath("/settings/integrations");
  return out.ok
    ? { ok: true, message: out.result === "adopted" ? `Existing number ${out.phoneNumber} adopted (fake provider).` : "This studio already has an active number." }
    : {
        ok: false,
        message:
          "uncertain" in out && out.uncertain
            ? "Not adopted: the provider could not confirm the number right now. Nothing was changed; try again shortly."
            : out.result === "refused" && "uncertain" in out
              ? `Not adopted: ${refusal(String(out.reason), str(formData, "country"))}. Nothing was changed; check the number and messaging service and try again.`
              : `Not adopted: ${"reason" in out ? refusal(String(out.reason), str(formData, "country")) : out.result}.`,
      };
}
