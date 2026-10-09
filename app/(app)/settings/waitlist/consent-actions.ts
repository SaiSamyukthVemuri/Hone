"use server";

import { revalidatePath } from "next/cache";

import { todayInTz } from "@/lib/booking/tz";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { createClient } from "@/lib/supabase/server";
import { lookupPhoneWideSuppression } from "@/lib/sms/phone-suppression-lookup";
import {
  PRACTITIONER_CONSENT_FIELDS,
  parsePractitionerSmsConsentInput,
} from "@/lib/waitlist/prospect-sms-consent";

// ===========================================================================
// 0208 — A STUDIO OWNER RECORDS SMS CONSENT GIVEN OUTSIDE HONE
// ===========================================================================
//
// One owner command, `record_waitlist_sms_consent_by_practitioner`, granted to
// service_role alone and re-deriving membership and the owner role from the
// actor it is given. That actor is the SESSION's user, never a form value: the
// browser supplies one entry id and the owner's answers, nothing else.
//
// WHAT THE OWNER ATTESTS, explicitly, in three answers with no defaults: that
// the person agreed to texts about this waitlist and any appointment offered
// from it; where the evidence of that agreement is; and either the day they
// agreed or that the day is not known. "Not known" is an answer, not a blank.
//
// STOP WINS, PHONE-WIDE, BEFORE THE COMMAND RUNS. The command refuses an entry
// whose own row says STOP; it cannot see a STOP the same number sent through
// another row, because phone matching lives in TypeScript (0202). So this
// action reads that first, through the same law the STOP route applies, and
// refuses rather than record a consent that could never take effect. A read
// that fails refuses too: an unchecked number is not recorded. The sender
// re-checks the same law at send time, so a STOP that lands after this check
// still wins.
//
// THE ENTRY'S NUMBER IS READ THROUGH THE OWNER'S OWN SESSION. 0185's owner
// SELECT policy already shows them this row; the service-role client is used
// only for what the session cannot do, the command and the phone-wide read.
//
// THE OWNER CHECK BELOW IS A CLEARER MESSAGE, NOT THE GUARANTEE. The command
// refuses a non-owner regardless, including a role changed after this check.
//
// PII. Names, emails, phone numbers, evidence and dates never reach a log line.
// ===========================================================================

export type WaitlistConsentActionResult = { ok: true } | { ok: false; message: string };

/** Every result the command can return. Typed so a new code is a compile error. */
type RecordConsentResult =
  | "recorded"
  | "already_consented"
  | "opted_out"
  | "no_phone"
  | "not_active"
  | "not_found"
  | "not_owner"
  | "not_a_member"
  | "invalid_input";

const OWNER_ONLY = "Only the studio owner can record SMS consent.";
const CHECK_FAILED =
  "Couldn't check this number against opt-outs. Nothing was recorded. Please try again.";
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REFUSALS: Readonly<Record<Exclude<RecordConsentResult, "recorded">, string>> = {
  already_consented:
    "This person already has SMS consent on record. Nothing was changed: existing consent is never replaced.",
  opted_out: "This person replied STOP. Consent can't be recorded for them.",
  no_phone: "There's no mobile number on file for this person, so consent can't be recorded.",
  not_active: "This person is no longer on the waitlist.",
  not_found: "That person is no longer on this studio's waitlist.",
  not_owner: OWNER_ONLY,
  not_a_member: OWNER_ONLY,
  // Reached only when the answers passed the checks below and the database
  // still refused them, e.g. the studio's calendar day turning over at
  // midnight between this action's check and the command's own. The command
  // cannot say which answer it refused.
  invalid_input: "Check the evidence and the consent date, then try again.",
};

function logRefusal(studioId: string, outcome: string): void {
  console.error(
    JSON.stringify({
      event: "waitlist_sms_consent_record_failed",
      studioId,
      outcome,
      timestamp: new Date().toISOString(),
    }),
  );
}

export async function recordProspectSmsConsentAction(
  formData: FormData,
): Promise<WaitlistConsentActionResult> {
  let studioId: string;
  let actorUserId: string;
  let timezone: string | null;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") return { ok: false, message: OWNER_ONLY };
    // Nullable in the schema for an invited practitioner who has never signed
    // in. This one came FROM a session, so it is present; narrowed rather than
    // passed as null, which the command would refuse as `invalid_input`.
    if (!practitioner.user_id) return { ok: false, message: OWNER_ONLY };
    studioId = studio.id;
    actorUserId = practitioner.user_id;
    // Nullable in the schema (0010 gives it a default, not NOT NULL). The
    // command falls back to UTC for a null zone, so this does too: both sides
    // must agree on what "today" is.
    timezone =
      typeof (studio as { timezone?: unknown }).timezone === "string"
        ? (studio as { timezone: string }).timezone
        : null;
  } catch {
    return { ok: false, message: "We couldn't confirm your studio just now. Please try again." };
  }

  const entryIdRaw = formData.get("entry_id");
  const entryId = typeof entryIdRaw === "string" ? entryIdRaw.trim() : "";
  // Only a tampered form sends anything else; refused before any read.
  if (!UUID_SHAPE.test(entryId)) return { ok: false, message: "Missing waitlist entry." };

  const parsed = parsePractitionerSmsConsentInput(
    {
      attest: formData.get(PRACTITIONER_CONSENT_FIELDS.attest),
      evidence: formData.get(PRACTITIONER_CONSENT_FIELDS.evidence),
      dateKnown: formData.get(PRACTITIONER_CONSENT_FIELDS.dateKnown),
      givenOn: formData.get(PRACTITIONER_CONSENT_FIELDS.givenOn),
    },
    todayInTz(timezone ?? "UTC"),
  );
  if (!parsed.ok) return { ok: false, message: parsed.message };

  // STOP, PHONE-WIDE. Scoped by id AND studio. An entry this read cannot see,
  // or one with no number, is left to the command, which refuses it as
  // `not_found` or `no_phone`: there is nothing to check a STOP against. The
  // number cannot change underneath: 0202's guard lets a phone be added once
  // and never replaced.
  let phone: string | null;
  try {
    const session = await createClient();
    const { data: entry, error: entryError } = await session
      .from("new_client_waitlist_entries")
      .select("phone")
      .eq("id", entryId)
      .eq("studio_id", studioId)
      .maybeSingle();
    if (entryError) throw entryError;
    phone = (entry as { phone: string | null } | null)?.phone ?? null;
  } catch {
    logRefusal(studioId, "entry_read_failed");
    return { ok: false, message: CHECK_FAILED };
  }

  const admin = createAdminClient();
  if (phone) {
    const suppression = await lookupPhoneWideSuppression(admin, phone);
    if (!suppression.ok) {
      logRefusal(studioId, "suppression_read_failed");
      return { ok: false, message: CHECK_FAILED };
    }
    if (suppression.suppressed) {
      logRefusal(studioId, "phone_suppressed");
      return {
        ok: false,
        message: "This number replied STOP to Hone texts. Consent can't be recorded for it.",
      };
    }
  }

  const { data, error } = await admin.rpc("record_waitlist_sms_consent_by_practitioner", {
    p_studio_id: studioId,
    p_entry_id: entryId,
    p_actor_user_id: actorUserId,
    p_scope: parsed.value.scope,
    p_evidence_ref: parsed.value.evidenceRef,
    p_consent_date_known: parsed.value.consentDateKnown,
    p_consent_given_on: parsed.value.consentGivenOn,
  });

  if (error || data !== "recorded") {
    const outcome = error?.code ?? (typeof data === "string" ? data : "unknown");
    logRefusal(studioId, outcome);
    const known =
      typeof data === "string" && data in REFUSALS
        ? REFUSALS[data as Exclude<RecordConsentResult, "recorded">]
        : undefined;
    return { ok: false, message: known ?? "Couldn't record that consent. Please try again." };
  }

  revalidatePath("/settings/waitlist");
  return { ok: true };
}

/** The `(previousState, formData) => nextState` binding `useActionState` takes. */
export async function recordProspectSmsConsentFormAction(
  _prev: WaitlistConsentActionResult | null,
  formData: FormData,
): Promise<WaitlistConsentActionResult> {
  return recordProspectSmsConsentAction(formData);
}
