// The charting view choice ("Current view" / "New view"): a DISPLAY preference and nothing else.
//
// It lives in the person's own sign-in profile (Supabase Auth user_metadata), written through their own
// session. It grants no permission and no feature access, and no authorization decision may read it. Only a
// closed value is ever stored, anything unexpected reads as Current, and the write merges so every other
// profile key survives. Pure and client-safe: no server imports here.

export const CHARTING_VIEW_KEY = "charting_view";
export const CHARTING_VIEWS = ["current", "new"] as const;
export type ChartingView = (typeof CHARTING_VIEWS)[number];
export const DEFAULT_CHARTING_VIEW: ChartingView = "current";

export const NOT_REMEMBERED_MESSAGE =
  "Your choice wasn't remembered. Charting still works, and you may need to choose again next time.";

/** Exactly "current" or "new", else null. No trimming, no case folding. */
export function strictChartingView(value: unknown): ChartingView | null {
  return value === "current" || value === "new" ? value : null;
}

/** What a stored profile value means. Anything unexpected is Current. */
export function readChartingView(value: unknown): ChartingView {
  return strictChartingView(value) ?? DEFAULT_CHARTING_VIEW;
}

/** The preference out of a user's metadata object (any shape). */
export function chartingViewFromMetadata(metadata: unknown): ChartingView {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return DEFAULT_CHARTING_VIEW;
  return readChartingView((metadata as Record<string, unknown>)[CHARTING_VIEW_KEY]);
}

/**
 * The metadata to write: every existing key kept, only the charting-view key set. It is built here, in full,
 * so the write is correct whether the auth server merges or replaces the object it is sent.
 */
export function withChartingView(existing: unknown, view: ChartingView): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      if (k === "__proto__") continue;
      out[k] = v;
    }
  }
  out[CHARTING_VIEW_KEY] = view;
  return out;
}

// ---- Who sees the toggle -------------------------------------------------------------------------------------
// The rollout (off, pilot or all studios) is decided on the SERVER by lib/rollouts/charting-rollout.ts and passed in as a plain boolean; this
// module reads no environment variable and no database.

/**
 * What to render. When the toggle is hidden the view is ALWAYS Current, whatever the stored value says, so turning the rollout off really does
 * take New view away from everyone.
 */
export function resolveChartingView(metadata: unknown, toggleVisible: boolean): { toggleVisible: boolean; view: ChartingView } {
  return { toggleVisible, view: toggleVisible ? chartingViewFromMetadata(metadata) : DEFAULT_CHARTING_VIEW };
}
