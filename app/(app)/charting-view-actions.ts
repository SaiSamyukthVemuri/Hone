"use server";

import { createClient } from "@/lib/supabase/server";
import {
  NOT_REMEMBERED_MESSAGE,
  strictChartingView,
  withChartingView,
} from "@/lib/charting/view-preference";

export type ChartingViewResult = { ok: true } | { ok: false; error: string };

/**
 * Remember the person's charting view in their own sign-in profile. It writes ONE key, merged into the metadata
 * they already have, through their own session. It touches no clinical record, appointment, message or payment,
 * and what it stores grants nothing. Any failure is reported as "not remembered" and never thrown, so the page
 * keeps working.
 */
export async function setChartingViewAction(view: unknown): Promise<ChartingViewResult> {
  const next = strictChartingView(view);
  if (next === null) return { ok: false, error: NOT_REMEMBERED_MESSAGE };
  try {
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
