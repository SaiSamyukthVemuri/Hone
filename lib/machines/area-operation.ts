/**
 * THE IDENTITY OF ONE INTENDED "create this treatment area" SAVE, carried in
 * the URL so it survives a reload.
 *
 * WHY THIS EXISTS. The initial save's retry key lived only in React state, so
 * a reload, a tab close or browser Back discarded it. A save that had
 * committed and only lost its answer then became a SECOND treatment area when
 * she re-entered the same settings (Codex #860 4302218408).
 *
 * IT IS NOT PAYLOAD MATCHING, and that is the whole point. The first attempt
 * at this matched claims by payload digest, and Sam rejected it: payload
 * equality cannot tell a lost retry apart from a second area the practitioner
 * meant to create, and the only escape it left was to alter a clinical value.
 * **She must never have to change a clinical value to get past duplicate
 * suppression.** So the id carries the intent and nothing infers it.
 *
 * NOTHING IN THE DATABASE CHANGES. 0223's `treatment_area_create_claims` is
 * already unique on `(session_id, idempotency_key)` alone and keeps
 * `payload_digest` as evidence rather than as a decider — the same posture
 * `session_copy_operations` (0157) uses. Key-only dedupe already satisfies
 * Sam's rule. The only broken thing was that the key did not survive a
 * reload, and that is all this fixes.
 *
 * WHY THE URL AND NOT STORAGE. This repository persists nothing in the
 * browser — the single `localStorage` reference is a comment asserting none is
 * used — and storage fails OPEN in a private window, with cleared site data,
 * and on another device, which is the direction that costs a duplicate
 * clinical record. A URL survives reload and Back for free, and a fresh form
 * open simply has no id, which is exactly what a deliberate second identical
 * area needs.
 */

/** The query parameter the id travels in. */
export const AREA_OP_PARAM = "area_op";

/**
 * A v4-shaped uuid, which is what `crypto.randomUUID()` mints.
 *
 * ANYTHING ELSE IS NOT AN ID WE MINTED, and is not treated as one. A
 * hand-edited, truncated or crafted value must never become an idempotency
 * key: a key we did not mint could collide with a real save and have THAT
 * save's treatment area returned for this one.
 */
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAreaOperationId(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/**
 * Just enough of `URLSearchParams` to read and copy one.
 *
 * Structural rather than nominal so this module stays free of
 * `next/navigation` — `ReadonlyURLSearchParams`, a real `URLSearchParams` and
 * a plain test double all satisfy it.
 */
type ReadableParams = {
  getAll(name: string): string[];
  entries(): IterableIterator<[string, string]> | Iterable<[string, string]>;
};

/**
 * The operation id the URL is carrying, or null.
 *
 * FAILS SAFE TO NULL, NEVER TO A GUESS. Missing, malformed, non-uuid or
 * REPEATED all read as null, and the caller then mints. The two directions do
 * not fail symmetrically: minting an unnecessary id costs at worst one extra
 * area she can delete, while honouring a value we did not mint can hand her
 * another save's treatment area.
 *
 * `getAll`, not `get`: a repeated parameter is a crafted or corrupted URL, and
 * taking the first of several would be choosing one arbitrarily.
 */
export function readAreaOperationId(
  search: ReadableParams | string | null | undefined,
): string | null {
  if (search == null) return null;
  const params =
    typeof search === "string" ? new URLSearchParams(search) : search;
  const found = params.getAll(AREA_OP_PARAM);
  if (found.length !== 1) return null;
  return isAreaOperationId(found[0]) ? found[0] : null;
}

/**
 * The search string this URL should carry for `id`, or without the parameter
 * at all when `id` is null.
 *
 * Pure, so the rule is testable without a browser. Returns the string with no
 * leading "?", and an empty string when nothing is left, so a caller can build
 * `pathname + (s ? "?" + s : "")` and never leave a bare "?" behind.
 *
 * It REWRITES rather than appends: setting an id over an existing one replaces
 * it, which is what a re-mint after a draft change needs, and it cannot leave
 * behind the repeated parameter that `readAreaOperationId` would then
 * correctly refuse to read.
 */
export function areaOperationSearch(
  search: ReadableParams | string | null | undefined,
  id: string | null,
): string {
  const params = new URLSearchParams(
    search == null
      ? ""
      : typeof search === "string"
        ? search
        : // A readonly params object cannot be mutated, so copy it through its
          // own entries rather than assuming a constructor accepts it.
          Array.from(search.entries()),
  );
  params.delete(AREA_OP_PARAM);
  if (id !== null) {
    if (!isAreaOperationId(id)) {
      // Refused here so a malformed id never reaches the URL at all, and the
      // reader never has to decide what a half-written one means.
      throw new Error("area operation id must be a v4 uuid");
    }
    params.set(AREA_OP_PARAM, id);
  }
  return params.toString();
}

/**
 * The operation id THE ADDRESS BAR is carrying, or null.
 *
 * THE READ THAT MATCHES THE WRITE. `syncAreaOperationParam` edits
 * `window.location` through `history.replaceState`, so this is the only read
 * that sees the current value. Reading the ROUTER's params instead returns
 * whatever the last real navigation carried, which is the defect this pair
 * exists to close — see the block comment on `readAreaOperationIdAtMount`.
 *
 * Null outside the browser, where there is no address bar to read.
 */
export function readAreaOperationIdFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  return readAreaOperationId(new URL(window.location.href).searchParams);
}

/**
 * The operation id a FORM MOUNT is resuming, from whichever surface exists.
 *
 * THE DEFECT THIS CLOSES, taken from the browser run's URL timeline on #922:
 *
 *     area_op=A    a lost save minted it
 *     <cleared>    START NEW released it
 *     area_op=B    the next area's own key
 *     <cleared>    that save settled
 *     area_op=A    <-- the released key came BACK on the next mount
 *
 * The key is written with `history.replaceState`, which deliberately does not
 * notify the router. The mount read was `readAreaOperationId(useSearchParams())`
 * — the ROUTER's view — so it reported the value from the LAST REAL
 * NAVIGATION and every later mount in that page's life resumed THAT key,
 * ignoring every clear and every mint since. After any reload that carried an
 * `area_op`, which is exactly the scenario the feature is for, every
 * subsequent Add re-asked the resume question about a save that was over and
 * held Save until she answered it.
 *
 * SO THE ADDRESS BAR WINS WHEREVER IT EXISTS, and the router's params are
 * consulted only on the SERVER render, where there is no address bar and
 * where they are the request's own params — so the first client render agrees
 * with the server markup and hydration is unaffected.
 *
 * THE DECISION LIVES HERE, beside the write, rather than in the form. A
 * caller that has to remember which of two surfaces to read is a caller that
 * will read the wrong one; `tests/lib/machines/area-operation-mount-read.test.ts`
 * pins that create mode does not.
 */
export function readAreaOperationIdAtMount(
  routerSearch: ReadableParams | string | null | undefined,
): string | null {
  if (typeof window === "undefined") return readAreaOperationId(routerSearch);
  return readAreaOperationIdFromLocation();
}

/**
 * Put the current operation id into the address bar, or take it out.
 *
 * `history.replaceState`, NOT the Next router, and the distinction is
 * load-bearing. `router.replace` would re-render the route and refetch the
 * server component in the middle of an outstanding save; this only edits the
 * current history entry, which is all a value read once at mount needs. It
 * also means `useSearchParams()` will NOT observe the change — correct here,
 * and the reason the form reads the parameter exactly once.
 *
 * It is a no-op outside the browser, so a server render cannot touch it.
 */
export function syncAreaOperationParam(id: string | null): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const next = areaOperationSearch(url.searchParams, id);
  // Rewriting the URL identically would still push a history mutation for no
  // reason, and on the drop path it is frequently already absent.
  const current = url.searchParams.toString();
  if (current === next) return;
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${next ? `?${next}` : ""}${url.hash}`,
  );
}

/**
 * Navigate the chart after a positive claim read, using the address bar rather
 * than the router's possibly stale canonical URL. A history-only clear followed
 * by router.refresh can restore the old key. Only retire the key this read
 * settled: another operation may now own the URL. No history is changed here.
 */
export function settledAreaOperationHref(settledId: string): string | null {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  if (isAreaOperationId(settledId) && readAreaOperationId(url.searchParams) === settledId) {
    url.searchParams.delete(AREA_OP_PARAM);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Closing one form must not abandon another form's operation. */
export function clearAreaOperationParamIfOwned(ownedId: string | null): void {
  if (ownedId !== null && isAreaOperationId(ownedId) && readAreaOperationIdFromLocation() === ownedId) {
    syncAreaOperationParam(null);
  }
}
