"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getRequiredAppOrigin } from "@/lib/app-origin";
import {
  runSenderAdoption,
  runSenderProvision,
  runSenderRelease,
  runSenderSearch,
  senderControlsFakeProvider,
  senderControlsGate,
  type SearchResult,
} from "@/lib/sms/sender-controls";
import {
  checkLiveTestText,
  checkPurchaseConfirmation,
  liveSenderControlsProvider,
  type ConfirmationRefusal,
} from "@/lib/sms/sender-controls-live";
import type { SmsProvisioningProvider } from "@/lib/sms/provider/types";

// SMS-SENDER-CONTROL-01 (#824): the owner's sender controls. Every action
// re-checks the gate FOR THIS STUDIO and takes its provider from one place,
// providerFor:
//   * fake mode (never in production, never with live provisioning armed):
//     the controls' own seeded FAKE, passed explicitly; it never resolves a
//     provider (lib/sms/sender-controls.ts, Codex P2 4250699100);
//   * live mode (HON-50, SMS-SENDER-LIVE-GATE-01; ships closed, production
//     only, operator-allowlisted studio): the real adapter, through
//     lib/sms/sender-controls-live.ts and nothing else.
// G3: provisioning is refused, before any provider is constructed, unless the
// owner confirmed THAT number; in live mode the owner also names and agrees to
// the phone that receives the one test text.

/** A synthetic destination for the fake provider's provisioning proof. */
const FAKE_TEST_DESTINATION = "+14165550199";

export type SenderControlResult = { ok: boolean; message: string };

type OwnerContext = { ok: true; studioId: string; actorUserId: string; mode: "fake" | "live" };

async function ownerContext(): Promise<OwnerContext | { ok: false; message: string }> {
  // The fake branch decides without a studio; the live branch is per studio,
  // so the studio is resolved (server-side, never from the browser) first.
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const gate = senderControlsGate(process.env, undefined, studio.id);
  if (!gate.open) return { ok: false, message: `Studio number controls are not available here (${gate.reason}).` };
  if (practitioner.role !== "owner" || !practitioner.user_id) {
    return { ok: false, message: "Only the studio owner can manage the studio number." };
  }
  return { ok: true, studioId: studio.id, actorUserId: practitioner.user_id, mode: gate.mode };
}

/** The ONE place an action gets its provider. */
function providerFor(ctx: OwnerContext): SmsProvisioningProvider {
  return ctx.mode === "live" ? liveSenderControlsProvider() : senderControlsFakeProvider(getRequiredAppOrigin(), ctx.studioId);
}

/** "(fake provider)" on every fake-mode success, never on a live one. */
const tag = (ctx: OwnerContext) => (ctx.mode === "fake" ? " (fake provider)" : "");

const CONFIRMATION_WORDS: Record<ConfirmationRefusal, string> = {
  purchase_not_confirmed: "Confirm that you want this number before it is set up. Nothing was bought",
  confirmation_number_mismatch: "The confirmation was for a different number. Choose the number again. Nothing was bought",
  test_text_not_confirmed: "Agree to the one test text before setup. Nothing was changed",
  test_destination_invalid: "Enter a Canadian or US mobile number you can receive the test text on. Nothing was changed",
};

/** The owner-facing words for a refusal reason. */
function refusal(reason: string, country: string): string {
  if (reason === "number_country_mismatch" || reason === "area_code_country_mismatch") {
    const name = country === "US" ? "a United States" : "a Canadian";
    return `That is not ${name} number. Choose a number in the country selected.`;
  }
  if (reason === "area_code_mismatch") return "That number is not in the area code you searched. Search again and choose a listed number";
  if (reason === "not_claimable") return "That number was just taken by another setup. Choose another number";
  if (reason === "resource_already_recorded") return "That number is already set up for a studio. Choose another number";
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
    { provider: providerFor(ctx) },
    { country: str(formData, "country"), areaCode: str(formData, "area_code") || null },
  );
}

export async function provisionSenderNumberAction(
  _prev: SenderControlResult | null,
  formData: FormData,
): Promise<SenderControlResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, message: ctx.message };
  const phoneNumber = str(formData, "phone_number");
  // G3, before any provider exists: no confirmation for THIS number, no purchase.
  const confirmed = checkPurchaseConfirmation({
    mode: ctx.mode,
    phoneNumber,
    confirmNumber: str(formData, "confirm_number"),
    confirmCost: str(formData, "confirm_cost"),
    testDestination: str(formData, "test_destination"),
    confirmTestText: str(formData, "confirm_test_text"),
  });
  if (!confirmed.ok) return { ok: false, message: `Not set up: ${CONFIRMATION_WORDS[confirmed.reason]}.` };
  // The invented fake destination is for the fake provider ONLY: a live run
  // without the owner's own phone is refused, never defaulted.
  const testDestination = ctx.mode === "live" ? confirmed.testDestination : FAKE_TEST_DESTINATION;
  if (!testDestination) return { ok: false, message: `Not set up: ${CONFIRMATION_WORDS.test_destination_invalid}.` };
  const out = await runSenderProvision(
    {
      admin: createAdminClient(),
      provider: providerFor(ctx),
      appOrigin: getRequiredAppOrigin(),
      testDestination,
    },
    {
      studioId: ctx.studioId,
      actorUserId: ctx.actorUserId,
      country: str(formData, "country"),
      areaCode: str(formData, "area_code") || null,
      phoneNumber,
    },
  );
  revalidatePath("/settings/integrations");
  return out.ok
    ? { ok: true, message: out.result === "activated" ? `Studio number ${out.phoneNumber} is set up${tag(ctx)}.` : "This studio already has an active number." }
    : { ok: false, message: `Not set up: ${"reason" in out ? refusal(String(out.reason), str(formData, "country")) : out.result}.` };
}

export async function adoptSenderNumberAction(
  _prev: SenderControlResult | null,
  formData: FormData,
): Promise<SenderControlResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, message: ctx.message };
  // Adoption buys nothing, but live adoption still sends one test text: only
  // to a phone the owner named and agreed to.
  let testDestination = FAKE_TEST_DESTINATION;
  if (ctx.mode === "live") {
    const consent = checkLiveTestText({
      testDestination: str(formData, "test_destination"),
      confirmTestText: str(formData, "confirm_test_text"),
    });
    if (!consent.ok || !consent.testDestination) {
      return { ok: false, message: `Not adopted: ${CONFIRMATION_WORDS[consent.ok ? "test_destination_invalid" : consent.reason]}.` };
    }
    testDestination = consent.testDestination;
  }
  const out = await runSenderAdoption(
    { admin: createAdminClient(), provider: providerFor(ctx), appOrigin: getRequiredAppOrigin(), testDestination },
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
    ? { ok: true, message: out.result === "adopted" ? `Existing number ${out.phoneNumber} adopted${tag(ctx)}.` : "This studio already has an active number." }
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

/**
 * Release a claim that failed BEFORE any purchase, so the owner can choose
 * another number (0226; Codex P2 4251989009). Refused, with nothing changed,
 * whenever the claim might own something.
 */
export async function releaseSenderClaimAction(
  _prev: SenderControlResult | null,
  _formData: FormData,
): Promise<SenderControlResult> {
  const ctx = await ownerContext();
  if (!ctx.ok) return { ok: false, message: ctx.message };
  const out = await runSenderRelease(
    { admin: createAdminClient(), provider: providerFor(ctx) },
    { studioId: ctx.studioId, actorUserId: ctx.actorUserId },
  );
  revalidatePath("/settings/integrations");
  if (out.ok) return { ok: true, message: "Released. Search again and choose a different number." };
  const words: Record<string, string> = {
    not_releasable: "This setup cannot be released here: it may own a number. Contact Hone support to finish or undo it.",
    resources_found: "The provider holds something under this setup, so it is not released. Contact Hone support to finish or undo it.",
    no_live_sender: "There is nothing to release.",
    sender_changed: "The setup changed while you were looking. Reload and try again.",
  };
  return {
    ok: false,
    message: out.uncertain
      ? "Hone could not confirm this setup owns nothing, so nothing was released. Try again shortly."
      : (words[out.reason] ?? `Not released: ${out.reason}.`),
  };
}
