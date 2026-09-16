"use server";

import { revalidatePath } from "next/cache";

import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isAvailabilityPreference } from "@/lib/waitlist/join-profile";

// ===========================================================================
// WAIT-04A — the three owner commands migration 0193 already ships
// ===========================================================================
//
//   public.set_waitlist_entry_availability(uuid, uuid, uuid, text)
//   public.create_practitioner_waitlist_entry(uuid, uuid, text, text, text, text)
//   public.import_legacy_waitlist_entry(uuid, uuid, text, text, timestamptz, text, text)
//
// NO MIGRATION AND NO NEW AUTHORITY. All three are `security definer`, all
// three re-derive the actor through `new_client_waitlist_resolve_owner`, and
// EXECUTE on each is granted to `service_role` alone — revoked by name from
// public, anon, authenticated AND service_role first, then granted back to
// service_role, which is the 0129/0164 shape. `authenticated` holds SELECT and
// nothing else on `new_client_waitlist_entries` (0185) and column-SELECT only
// on `new_client_waitlist_entry_preferences` (0193), so there is no direct-DML
// route to any of this and this module is the only application path.
//
// They shipped with ZERO callers. That is the defect this slice closes: the
// database has been able to do all three since 0193 was applied, and the
// product could not ask.
//
// THE OWNER CHECK BELOW IS A CLEARER MESSAGE, NOT THE GUARANTEE. Each command
// refuses a non-owner regardless, and a role that changes between this check
// and the call is refused there rather than here.
//
// PII. Names, emails, phone numbers and dates never reach a log line.
// ===========================================================================

export type WaitlistProfileActionResult = { ok: true } | { ok: false; message: string };

/** The codes every 0193 command propagates from `new_client_waitlist_resolve_owner`. */
const AUTHORITY_REFUSALS: Readonly<Record<string, string>> = {
  not_owner: "Only the studio owner can change the waitlist.",
  not_a_member: "Only the studio owner can change the waitlist.",
};

async function resolveOwner(): Promise<
  { ok: true; studioId: string; actorUserId: string } | { ok: false; message: string }
> {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") {
      return { ok: false, message: "Only the studio owner can change the waitlist." };
    }
    // Nullable in the schema for an invited practitioner who has never signed
    // in. This one came FROM a session, so it is present — narrowed rather than
    // passed as null, which the command would refuse as `invalid_input`.
    const actorUserId = practitioner.user_id;
    if (!actorUserId) {
      return { ok: false, message: "Only the studio owner can change the waitlist." };
    }
    return { ok: true, studioId: studio.id, actorUserId };
  } catch {
    return { ok: false, message: "We couldn't confirm your studio just now. Please try again." };
  }
}

/** PII-free. The outcome code and the studio, never a name, email or date. */
function logRefusal(event: string, studioId: string, outcome: string): void {
  console.error(
    JSON.stringify({ event, studioId, outcome, timestamp: new Date().toISOString() }),
  );
}

function refusalMessage(
  data: unknown,
  refusals: Readonly<Record<string, string>>,
  generic: string,
): string {
  const known = typeof data === "string" ? refusals[data] : undefined;
  return known ?? generic;
}

/**
 * `returns table (result, entry_id)` arrives as an ARRAY of rows, unlike the
 * scalar `returns text` commands. Reading `data` as a string there would make
 * every outcome look like a refusal, so the shape is narrowed once here rather
 * than at each call site.
 */
function firstResultCode(data: unknown): string | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as { result?: unknown };
  return typeof row?.result === "string" ? row.result : null;
}

function requiredText(formData: FormData, field: string): string | null {
  const raw = formData.get(field);
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalText(formData: FormData, field: string): string | null {
  return requiredText(formData, field);
}

// --- AVAILABILITY ------------------------------------------------------------
//
// 0193: `stated` | `changed` | `confirmed` | `entry_not_found` | `entry_closed`
// | `invalid_input` + owner codes.
//
// THREE SUCCESS CODES, NOT ONE, and they are not interchangeable. The
// preferences table carries `stated_at` (when the VALUE was last set) and
// `confirmed_at` (when it was last AFFIRMED, changed or not) precisely so a
// preference held for months is not mistaken for one set last week. The
// command reports which of the three happened; this action treats all three as
// success because from the owner's side the answer is simply "recorded", and
// the distinction is preserved where it matters — in the two columns.

const AVAILABILITY_SUCCESS = new Set(["stated", "changed", "confirmed"]);

const AVAILABILITY_REFUSALS: Readonly<Record<string, string>> = {
  entry_not_found: "That person is no longer on this studio's waitlist.",
  entry_closed: "Availability can only be recorded while someone is still on the waitlist.",
  ...AUTHORITY_REFUSALS,
};

export async function setWaitlistAvailabilityAction(
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  const owner = await resolveOwner();
  if (!owner.ok) return owner;

  const entryId = requiredText(formData, "entry_id");
  if (!entryId) return { ok: false, message: "Missing waitlist entry." };

  // VALIDATED HERE AS WELL AS IN THE DATABASE. The command's CHECK is the
  // authority, but a typo'd value should read as "pick one of three" rather
  // than as the command's `invalid_input`, which cannot say which argument
  // was wrong.
  const preference = requiredText(formData, "preference");
  if (!preference || !isAvailabilityPreference(preference)) {
    return { ok: false, message: "Choose weekdays, weekends, or both." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("set_waitlist_entry_availability", {
    p_studio_id: owner.studioId,
    p_entry_id: entryId,
    p_actor_user_id: owner.actorUserId,
    p_preference: preference,
  });

  if (error || typeof data !== "string" || !AVAILABILITY_SUCCESS.has(data)) {
    const outcome = error?.code ?? (typeof data === "string" ? data : "unknown");
    logRefusal("waitlist_availability_failed", owner.studioId, outcome);
    return {
      ok: false,
      message: refusalMessage(
        data,
        AVAILABILITY_REFUSALS,
        "Could not record that availability. Please try again.",
      ),
    };
  }

  revalidatePath("/settings/waitlist");
  return { ok: true };
}

// --- MANUAL ENTRY ------------------------------------------------------------
//
// 0193: `created` | `already_waiting` | `invalid_input` + owner codes.
//
// `source` IS 'practitioner' AND `joined_at` IS NOW. The command owns both and
// takes neither from this caller — there is no parameter for either. Someone
// the studio adds today joined today; back-dating is the import command's job
// and is a different, explicitly-evidenced claim.

const CREATE_REFUSALS: Readonly<Record<string, string>> = {
  already_waiting: "Someone with that email is already waiting.",
  invalid_input: "Enter a name and an email address.",
  ...AUTHORITY_REFUSALS,
};

export async function addWaitlistEntryAction(
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  const owner = await resolveOwner();
  if (!owner.ok) return owner;

  const name = requiredText(formData, "name");
  const email = requiredText(formData, "email");
  if (!name || !email) return { ok: false, message: "Enter a name and an email address." };

  // OPTIONAL, AND ABSENT IS NOT 'both'. A preference nobody stated must stay
  // unstated: defaulting it here would manufacture an answer the person never
  // gave, and `both` is the value most likely to be wrong for a real person.
  const preference = optionalText(formData, "preference");
  if (preference !== null && !isAvailabilityPreference(preference)) {
    return { ok: false, message: "Choose weekdays, weekends, or both." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("create_practitioner_waitlist_entry", {
    p_studio_id: owner.studioId,
    p_actor_user_id: owner.actorUserId,
    p_name: name,
    p_email: email,
    p_phone: optionalText(formData, "phone"),
    p_preference: preference,
  });

  const code = firstResultCode(data);
  if (error || code !== "created") {
    logRefusal("waitlist_manual_entry_failed", owner.studioId, error?.code ?? code ?? "unknown");
    return {
      ok: false,
      message: refusalMessage(
        code,
        CREATE_REFUSALS,
        "Could not add that person to the waitlist. Please try again.",
      ),
    };
  }

  revalidatePath("/settings/waitlist");
  return { ok: true };
}

// --- LEGACY IMPORT -----------------------------------------------------------
//
// 0193: `imported` | `already_waiting` | `invalid_input` | `invalid_provenance`
// | `joined_at_required` | `joined_at_in_future` + owner codes.
//
// TWO PROVENANCES, AND THE DIFFERENCE IS THE POINT.
//
//   'operator_supplied' — the studio HAS a date and is standing behind it. The
//     command stores it verbatim, so the row takes its true position in the
//     (joined_at, id) queue ahead of people who joined later. `joined_at` is
//     REQUIRED, and a future date is refused.
//
//   'unknown' — nobody has a date. The command stamps `joined_at` with the
//     import instant purely so the row has a position, and leaves the
//     provenance at 'unknown' so that no reader renders it as a wait. See
//     lib/waitlist/entry-provenance.ts, which is where that rule is enforced
//     for the UI.
//
// 'form' IS NOT OFFERED AND CANNOT BE. 0193's CHECK binds it to
// source = 'public_booking', and the command refuses anything but the two
// above. Only the public form may claim the form stamped it.

const IMPORT_PROVENANCES = ["operator_supplied", "unknown"] as const;
type ImportProvenance = (typeof IMPORT_PROVENANCES)[number];

function isImportProvenance(value: string): value is ImportProvenance {
  return (IMPORT_PROVENANCES as readonly string[]).includes(value);
}

const IMPORT_REFUSALS: Readonly<Record<string, string>> = {
  already_waiting: "Someone with that email is already waiting.",
  invalid_input: "Enter a name and an email address.",
  invalid_provenance: "Choose whether you have a join date for this person.",
  joined_at_required: "Enter the date this person joined, or choose that it is unknown.",
  joined_at_in_future: "A join date cannot be in the future.",
  ...AUTHORITY_REFUSALS,
};

export async function importLegacyWaitlistEntryAction(
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  const owner = await resolveOwner();
  if (!owner.ok) return owner;

  const name = requiredText(formData, "name");
  const email = requiredText(formData, "email");
  if (!name || !email) return { ok: false, message: "Enter a name and an email address." };

  const provenance = requiredText(formData, "provenance");
  if (!provenance || !isImportProvenance(provenance)) {
    return { ok: false, message: "Choose whether you have a join date for this person." };
  }

  // A DATE INPUT GIVES 'YYYY-MM-DD'. Sent as-is: the command's parameter is
  // `timestamptz` and PostgreSQL resolves a bare date at midnight, which is the
  // most conservative reading of "they joined on this day" — it never places
  // the row LATER in the queue than the studio's own claim.
  //
  // Under 'unknown' the field is not read at all, so a date left in the form
  // by a change of mind cannot leak into a row the studio just said it has no
  // date for.
  const joinedAt = provenance === "operator_supplied" ? requiredText(formData, "joined_at") : null;
  if (provenance === "operator_supplied" && !joinedAt) {
    return { ok: false, message: "Enter the date this person joined, or choose that it is unknown." };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("import_legacy_waitlist_entry", {
    p_studio_id: owner.studioId,
    p_actor_user_id: owner.actorUserId,
    p_name: name,
    p_email: email,
    p_joined_at: joinedAt,
    p_provenance: provenance,
    p_phone: optionalText(formData, "phone"),
  });

  const code = firstResultCode(data);
  if (error || code !== "imported") {
    logRefusal("waitlist_legacy_import_failed", owner.studioId, error?.code ?? code ?? "unknown");
    return {
      ok: false,
      message: refusalMessage(
        code,
        IMPORT_REFUSALS,
        "Could not add that person from your records. Please try again.",
      ),
    };
  }

  revalidatePath("/settings/waitlist");
  return { ok: true };
}

// --- useActionState BINDINGS -------------------------------------------------
//
// `useActionState` binds `(previousState, formData) => nextState`, so each
// action needs a two-argument form. The previous state is deliberately ignored:
// every one of these commands is decided entirely by the database from the
// form's own fields, and a decision that consulted the last render's result
// would be a second, weaker authority.

export async function setWaitlistAvailabilityFormAction(
  _prev: WaitlistProfileActionResult | null,
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  return setWaitlistAvailabilityAction(formData);
}

export async function addWaitlistEntryFormAction(
  _prev: WaitlistProfileActionResult | null,
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  return addWaitlistEntryAction(formData);
}

export async function importLegacyWaitlistEntryFormAction(
  _prev: WaitlistProfileActionResult | null,
  formData: FormData,
): Promise<WaitlistProfileActionResult> {
  return importLegacyWaitlistEntryAction(formData);
}
