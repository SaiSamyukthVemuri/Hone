"use server";

// Practitioner-only birthday update.
//
// Stores month + day in the existing public.clients.date_of_birth column
// (no schema change needed — the column has been there since migration
// 0001). We deliberately avoid asking the practitioner for a year — only
// month and day are needed for the "happy birth month" reminder.
//
// Year handling rules:
//   * If the client already has a real year stored (anything other than
//     the 1900 sentinel), preserve it on edit so we don't quietly
//     overwrite age data the practitioner entered through the full
//     client edit form.
//   * New entries get year 1900 as a sentinel. The UI never displays
//     the year; the year column exists only because the DB type is
//     `date` and needs one.
//
// This action does NOT send emails, NOT send SMS, NOT enqueue any job,
// NOT touch booking, NOT touch Stripe. It is practitioner-facing only;
// the data is never exposed to public/email/cron/api surfaces (audited
// by grep in PR #28).

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export type BirthdayActionResult =
  | { ok: true }
  | { ok: false; error: string };

const SENTINEL_YEAR = 1900;

function parseIntOrNull(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length === 0) return null;
  const n = parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

export async function updateClientBirthdayAction(
  formData: FormData,
): Promise<BirthdayActionResult> {
  const clientIdRaw = formData.get("client_id");
  const clientId =
    typeof clientIdRaw === "string" ? clientIdRaw.trim() : "";
  if (!clientId) return { ok: false, error: "Missing client id." };

  const month = parseIntOrNull(formData.get("birthday_month"));
  const day = parseIntOrNull(formData.get("birthday_day"));

  // Both empty → clear birthday (set date_of_birth to NULL).
  if (month == null && day == null) {
    const { studio } = await getCurrentPractitionerWithStudio();
    const supabase = await createClient();
    const { data: client, error: clientErr } = await supabase
      .from("clients")
      .select("id")
      .eq("id", clientId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (clientErr) return { ok: false, error: clientErr.message };
    if (!client) return { ok: false, error: "Client not found." };

    const { error } = await supabase
      .from("clients")
      .update({ date_of_birth: null })
      .eq("id", clientId)
      .eq("studio_id", studio.id);
    if (error) {
      return { ok: false, error: `Failed to clear birthday: ${error.message}` };
    }
    revalidatePath(`/clients/${clientId}`);
    revalidatePath("/dashboard");
    return { ok: true };
  }

  // Saving a birthday requires both fields. If the practitioner partially
  // filled the form, surface a clean error rather than silently storing a
  // half-set date.
  if (month == null || day == null) {
    return {
      ok: false,
      error:
        "Pick a month and a day, or clear both to remove the birthday.",
    };
  }
  if (month < 1 || month > 12) {
    return { ok: false, error: "Month must be between 1 and 12." };
  }
  if (day < 1 || day > 31) {
    return { ok: false, error: "Day must be between 1 and 31." };
  }

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Load current to decide which year to keep. RLS would refuse the
  // update anyway; the explicit lookup gives a cleaner error.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id, date_of_birth")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };

  let year = SENTINEL_YEAR;
  if (client.date_of_birth) {
    const existingYear = parseInt(
      String(client.date_of_birth).slice(0, 4),
      10,
    );
    if (
      Number.isFinite(existingYear) &&
      existingYear >= 1900 &&
      existingYear < 3000
    ) {
      year = existingYear;
    }
  }

  // Calendar correctness: reject Feb 30, Apr 31, etc. JavaScript Date
  // silently rolls over invalid days; we compare the resulting month/day
  // back to the input to detect overflow.
  const probe = new Date(year, month - 1, day);
  if (probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return { ok: false, error: "Pick a real calendar date." };
  }

  const dob = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const { error } = await supabase
    .from("clients")
    .update({ date_of_birth: dob })
    .eq("id", clientId)
    .eq("studio_id", studio.id);
  if (error) {
    return { ok: false, error: `Failed to save birthday: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  return { ok: true };
}
