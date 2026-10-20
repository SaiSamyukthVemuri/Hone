import type { GridPhotoVariant } from "./grid-photo-recovery";

// FETT photos (HON-43): the browser side of a photo-cell re-mint. One GET to
// the signed-url route, abortable through `signal` (the cell's timeout aborts
// it, so a retry is a genuinely new request and nothing queues behind a hung
// one; see the route's header for why this is not a server action).
//
// Outcomes, matching lib/images/grid-photo-recovery.ts:
//   * 200 with a URL               -> the URL;
//   * ANY other answer             -> null, a DEFINITIVE refusal (terminal for
//     the variant, no retry). That includes every 3xx: the session middleware
//     answers a signed-out or no-practitioner request with a redirect, and
//     `redirect: "manual"` surfaces it as an opaque redirect instead of
//     following it to an HTML page;
//   * network failure or abort     -> the promise REJECTS, which the hook
//     treats exactly like a timeout (retry once, then terminal).
export function signedImageUrlPath(clientId: string, imageId: string, variant: GridPhotoVariant): string {
  return `/api/clients/${encodeURIComponent(clientId)}/images/${encodeURIComponent(imageId)}/signed-url?variant=${variant}`;
}

export async function fetchSignedImageUrl(input: {
  clientId: string;
  imageId: string;
  variant: GridPhotoVariant;
  signal: AbortSignal;
}): Promise<string | null> {
  const res = await fetch(signedImageUrlPath(input.clientId, input.imageId, input.variant), {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    redirect: "manual",
    signal: input.signal,
  });
  if (res.type === "opaqueredirect" || res.status !== 200) return null;
  const body: unknown = await res.json().catch(() => null);
  const url = body && typeof body === "object" ? (body as { url?: unknown }).url : null;
  return typeof url === "string" && url.length > 0 ? url : null;
}
