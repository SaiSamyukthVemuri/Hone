"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

// PR #164. Practitioner notification center actions.
//
// All actions here run as the authenticated practitioner and use
// the RLS client (not the admin client). The studio scope is
// resolved server-side via getCurrentPractitionerWithStudio so a
// tampered formData cannot redirect the mark-read to a different
// studio's notifications; the WITH CHECK clause on
// practitioner_notifications_member_update (migration 0070) is the
// belt to this suspender.

export type MarkAllReadResult =
  | { ok: true; updated: number }
  | { ok: false; error: string };

export async function markAllNotificationsAsReadAction(): Promise<MarkAllReadResult> {
  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();
  // Stamp read_at on every unread row scoped to the authenticated
  // studio. The .eq("studio_id", studio.id) is the server-resolved
  // scope; combined with the RLS USING + WITH CHECK clause it
  // means a member can only mark their own studio's rows read,
  // and only the unread ones receive a new timestamp.
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("practitioner_notifications")
    .update({ read_at: nowIso })
    .eq("studio_id", studio.id)
    .is("read_at", null)
    .select("id");
  if (error) {
    return {
      ok: false,
      error:
        "Couldn't mark notifications read. Please refresh and try again.",
    };
  }
  revalidatePath("/notifications");
  // Re-revalidate the app layout so the header badge re-counts.
  revalidatePath("/", "layout");
  return { ok: true, updated: data?.length ?? 0 };
}

// Void-returning wrapper for use as a <form action={...}>. Keeps
// markAllNotificationsAsReadAction's typed return value available
// for tests and programmatic callers; the form path just fires the
// mutation and lets revalidatePath rerender the page + header.
export async function markAllReadFormAction(_formData: FormData): Promise<void> {
  await markAllNotificationsAsReadAction();
}
