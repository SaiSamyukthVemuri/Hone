"use server";

import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  NOT_REMEMBERED_MESSAGE,
  strictChartingView,
  withChartingView,
} from "@/lib/charting/view-preference";

export type ChartingViewResult = { ok: true } | { ok: false; error: string };

/**
 * Remember the person's charting view in their own sign-in profile. It writes ONE key, merged into the metadata
 * they already have, through their own session. It touches no clinical record, appointment, message or payment,
 * and what it stores grants nothing. Only an active practitioner may call it. Any failure is reported as "not remembered" and never thrown, so the page
 * keeps working.
 */
export async function setChartingViewAction(view: unknown): Promise<ChartingViewResult> {
  const next = strictChartingView(view);
  if (next === null) return { ok: false, error: NOT_REMEMBERED_MESSAGE };
  try {
    // The same identity gate as every other app-shell action: refuses (throws) unless the caller is an ACTIVE
    // practitioner, so a receptionist or a signed-in stranger is refused before anything is written. The write
    // below is still the person's own session, and the practitioner row is read for the gate only.
    await getCurrentPractitionerWithStudio();
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: NOT_REMEMBERED_MESSAGE };
    const { error } = await supabase.auth.updateUser({ data: withChartingView(user.user_metadata, next) });
    if (error) return { ok: false, error: NOT_REMEMBERED_MESSAGE };
    return { ok: true };
  } catch {
    return { ok: false, error: NOT_REMEMBERED_MESSAGE };
  }
}
