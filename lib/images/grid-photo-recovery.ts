// FETT photos (HON-43): how ONE Photos-tab grid cell recovers when its image
// will not load.
//
// The grid is `loading="lazy"` and its signed URLs live 60 s. A cell below the
// fold that is scrolled into view more than a minute after the page rendered
// asks for an EXPIRED URL. Both the derivative and the original fail, and
// before this change the cell went to "Image not available" while "View larger"
// (which mints a fresh URL per click) still worked.
//
// Recovery, pure and BOUNDED: each variant is re-minted AT MOST ONCE.
//   thumb (server URL) fails      -> re-mint thumb
//   re-minted thumb fails/missing -> original (server URL)
//   original fails                -> re-mint original
//   re-minted original fails      -> broken ("Image not available")
// So a cell makes at most two re-mint requests and can never loop.
//
// Availability still keys off the ORIGINAL (PERF-IMG-03): no server-signed
// original means no preview, exactly as before. Failure state is tied to the
// server URLs it was computed from (`key`), so fresh URLs from a
// router.refresh() start the cell over instead of leaving it dead.

export type GridPhotoVariant = "thumb" | "original";

export type GridPhotoState = {
  key: string;
  stage: GridPhotoVariant | "broken";
  src: string | null;
  reminted: { thumb: boolean; original: boolean };
  /** A re-mint request is in flight; ignore further errors until it lands. */
  pending: GridPhotoVariant | null;
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

/** The image failed to load. Returns the next state and, when needed, which variant to re-mint. */
export function onGridPhotoError(
  state: GridPhotoState,
  urls: GridPhotoUrls,
): { state: GridPhotoState; remint: GridPhotoVariant | null } {
  if (state.stage === "broken" || state.pending) return { state, remint: null };
  const variant = state.stage;
  if (!state.reminted[variant]) {
    return { state: { ...state, pending: variant }, remint: variant };
  }
  if (variant === "thumb") {
    return {
      state: urls.previewUrl
        ? { ...state, stage: "original", src: urls.previewUrl }
        : { ...state, stage: "broken", src: null },
      remint: null,
    };
  }
  return { state: { ...state, stage: "broken", src: null }, remint: null };
}

/** A re-mint request landed: a fresh URL, or null when the server refused or had none. */
export function onGridPhotoRemint(
  state: GridPhotoState,
  urls: GridPhotoUrls,
  variant: GridPhotoVariant,
  url: string | null,
): GridPhotoState {
  if (state.pending !== variant) return state;
  const reminted = { ...state.reminted, [variant]: true };
  if (url) return { ...state, src: url, reminted, pending: null };
  if (variant === "thumb" && urls.previewUrl) {
    return { ...state, stage: "original", src: urls.previewUrl, reminted, pending: null };
  }
  return { ...state, stage: "broken", src: null, reminted, pending: null };
}
