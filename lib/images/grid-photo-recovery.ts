// FETT photos (HON-43): how ONE photo cell (Photos grid, profile ID photo,
// visit chart) recovers when its image will not load.
//
// The signed URLs live 60 s. A cell whose image is requested after its URL
// expired (lazy below the fold, a page left open, a router-cache restore) asks
// for an EXPIRED URL. Before #913 it went to "Image not available" while
// "View larger" (which mints a fresh URL per click) still worked.
//
// Recovery, pure and BOUNDED: each variant is re-minted, and a re-mint that
// does not complete is retried ONCE.
//   thumb (server URL) fails         -> re-mint thumb (attempt 1)
//   that attempt times out / rejects -> re-mint thumb again (attempt 2)
//   attempt 2 times out / rejects, or any attempt returns NO URL
//                                    -> original (server URL)
//   original fails                   -> re-mint original (attempt 1, then 2)
//   still nothing                    -> broken ("Image not available")
// So a cell makes at most FOUR re-mint requests and can never loop.
//
// WHY ATTEMPTS AND A TIMEOUT (bounded pending). A browser proof with every
// request for the first signed token refused showed cells stranded on a dead
// URL: the re-mint server action sometimes never settled around hydration
// (4 of 10 instrumented runs reported the action fetch ERR_ABORTED), and an
// unbounded `pending` then waited forever. Next also runs a page's server
// actions ONE AT A TIME, so a hung re-mint action held its own retry and every
// later action on the page (Codex P1 4307807754); the re-mint is therefore an
// abortable GET (./remint-request, ./remint-controller), never an action, and
// a timed-out attempt is aborted before the retry is sent. A pending re-mint
// now ends by one of:
//   * its URL arriving (used whenever the cell is STILL waiting on that
//     variant, even from a superseded attempt: a slow first attempt that lands
//     after the retry started is still a good URL);
//   * a definitive "no URL" from the server (terminal for that variant);
//   * a timeout or a rejected promise (retry once, then terminal). A failure
//     from a superseded attempt is ignored, so it cannot cut the retry short.
//
// Availability still keys off the ORIGINAL (PERF-IMG-03): no server-signed
// original means no preview, exactly as before. Failure state is tied to the
// server URLs it was computed from (`key`), so fresh URLs from a
// router.refresh() start the cell over instead of leaving it dead.

export type GridPhotoVariant = "thumb" | "original";
export type RemintAttempt = 1 | 2;
export type RemintRequest = { variant: GridPhotoVariant; attempt: RemintAttempt };

/**
 * How long a re-mint may take before it is treated as failed and retried.
 * Observed re-mint round trips were 532–700 ms on a local stack, so 8 s is
 * roughly ten times that, and well under the 60 s signed-URL TTL: a retry
 * still lands while a fresh URL is useful.
 */
export const GRID_PHOTO_REMINT_TIMEOUT_MS = 8000;

export type GridPhotoState = {
  key: string;
  stage: GridPhotoVariant | "broken";
  src: string | null;
  /** The variant has finished its re-mint (a URL arrived, or it gave up). */
  reminted: { thumb: boolean; original: boolean };
  /** A re-mint is in flight; further image errors are ignored until it ends. */
  pending: RemintRequest | null;
};

export type GridPhotoUrls = { previewUrl: string | null; thumbUrl: string | null };

export function gridPhotoKey(urls: GridPhotoUrls): string {
  return `${urls.previewUrl ?? ""}\n${urls.thumbUrl ?? ""}`;
}

export function initialGridPhoto(urls: GridPhotoUrls): GridPhotoState {
  const reminted = { thumb: false, original: false };
  const key = gridPhotoKey(urls);
  if (!urls.previewUrl) return { key, stage: "broken", src: null, reminted, pending: null };
  if (urls.thumbUrl) return { key, stage: "thumb", src: urls.thumbUrl, reminted, pending: null };
  return { key, stage: "original", src: urls.previewUrl, reminted, pending: null };
}

/** Give up on `variant`: the derivative demotes to the original; the original breaks. */
function giveUp(state: GridPhotoState, urls: GridPhotoUrls, variant: GridPhotoVariant): GridPhotoState {
  const reminted = { ...state.reminted, [variant]: true };
  if (variant === "thumb" && urls.previewUrl) {
    return { ...state, stage: "original", src: urls.previewUrl, reminted, pending: null };
  }
  return { ...state, stage: "broken", src: null, reminted, pending: null };
}

/** The image failed to load. Returns the next state and, when needed, the re-mint to issue. */
export function onGridPhotoError(
  state: GridPhotoState,
  urls: GridPhotoUrls,
): { state: GridPhotoState; remint: RemintRequest | null } {
  if (state.stage === "broken" || state.pending) return { state, remint: null };
  const variant = state.stage;
  if (!state.reminted[variant]) {
    const remint: RemintRequest = { variant, attempt: 1 };
    return { state: { ...state, pending: remint }, remint };
  }
  // A re-minted URL failed to load too: nothing more to try for this variant.
  return { state: giveUp(state, urls, variant), remint: null };
}

/**
 * A re-mint returned. `url` null means the server had nothing to give
 * (definitive: terminal for the variant). A URL is used whenever the cell is
 * still waiting on that variant, whichever attempt produced it; once the cell
 * has moved on (another variant, or nothing pending), the result is ignored.
 */
export function onGridPhotoRemint(
  state: GridPhotoState,
  urls: GridPhotoUrls,
  variant: GridPhotoVariant,
  url: string | null,
): GridPhotoState {
  if (!state.pending || state.pending.variant !== variant) return state;
  if (url) return { ...state, src: url, reminted: { ...state.reminted, [variant]: true }, pending: null };
  return giveUp(state, urls, variant);
}

/**
 * A re-mint did not complete: it timed out, or its promise rejected. Only the
 * CURRENT attempt counts; a failure from a superseded attempt is ignored.
 * Attempt 1 is retried once; attempt 2 gives up on the variant.
 */
export function onGridPhotoRemintFailed(
  state: GridPhotoState,
  urls: GridPhotoUrls,
  variant: GridPhotoVariant,
  attempt: RemintAttempt,
): { state: GridPhotoState; remint: RemintRequest | null } {
  const p = state.pending;
  if (!p || p.variant !== variant || p.attempt !== attempt) return { state, remint: null };
  if (attempt === 1) {
    const remint: RemintRequest = { variant, attempt: 2 };
    return { state: { ...state, pending: remint }, remint };
  }
  return { state: giveUp(state, urls, variant), remint: null };
}
