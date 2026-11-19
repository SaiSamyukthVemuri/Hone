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

// ---- Who sees the toggle (the rollout and the kill switch) -------------------------------------------------
export const CHARTING_VIEW_STUDIOS_ENV = "HONE_CHARTING_NEW_VIEW_STUDIO_IDS";

export type ChartingViewGate = { kind: "off" } | { kind: "all" } | { kind: "list"; ids: ReadonlySet<string> };

const STUDIO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Empty, missing or unreadable = OFF (the kill switch: nobody sees the toggle). The single word "all" = every
 * studio. Otherwise a comma-separated list of studio ids; a token that is not a plain id is dropped, so a typo
 * can only shrink the list.
 */
export function parseChartingViewGate(raw: string | undefined | null): ChartingViewGate {
  if (typeof raw !== "string") return { kind: "off" };
  const text = raw.trim().toLowerCase();
  if (text === "all") return { kind: "all" };
  const ids = new Set<string>();
  for (const token of text.split(",")) {
    const id = token.trim();
    if (STUDIO_ID_PATTERN.test(id)) ids.add(id);
  }
  return ids.size > 0 ? { kind: "list", ids } : { kind: "off" };
}

export function chartingViewToggleVisible(gate: ChartingViewGate, studioId: string | null | undefined): boolean {
  if (gate.kind === "all") return true;
  if (gate.kind === "off") return false;
  return typeof studioId === "string" && gate.ids.has(studioId.trim().toLowerCase());
}

/**
 * What to render. When the toggle is hidden the view is ALWAYS Current, whatever the stored value says, so the
 * kill switch really does take New view away from everyone.
 */
export function resolveChartingView(
  metadata: unknown,
  studioId: string | null | undefined,
  rawGate: string | undefined | null,
): { toggleVisible: boolean; view: ChartingView } {
  const toggleVisible = chartingViewToggleVisible(parseChartingViewGate(rawGate), studioId);
  return { toggleVisible, view: toggleVisible ? chartingViewFromMetadata(metadata) : DEFAULT_CHARTING_VIEW };
}
