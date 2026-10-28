import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readAreaOperationId,
  readAreaOperationIdAtMount,
  readAreaOperationIdFromLocation,
  syncAreaOperationParam,
  settledAreaOperationHref,
  clearAreaOperationParamIfOwned,
} from "@/lib/machines/area-operation";

// ===========================================================================
// THE KEY IS READ FROM THE SURFACE IT IS WRITTEN TO (Codex, #922)
// ===========================================================================
//
// WHERE THIS CAME FROM. Browser journey (ii) — "START NEW creates a SECOND
// area with IDENTICAL values" — failed on the application, and the trace's own
// URL timeline named the defect:
//
//     480178  <no query>          the page loads
//     482018  area_op=A           the lost save minted it
//     484729  <no query>          START NEW released it
//     486199  area_op=B           the first area's own key
//     487026  <no query>          that save settled, key cleared
//     488746  area_op=A    <--    THE RELEASED KEY IS BACK
//
// The database agreed: ONE block and ONE claim, under B. A had no claim at
// all, because that save never reached the server.
//
// THE MECHANISM. The key is WRITTEN with `window.history.replaceState`, which
// deliberately does not notify the router. The mount READ was
// `readAreaOperationId(useSearchParams())` — the ROUTER's view — so it
// reported whatever the LAST REAL NAVIGATION carried. After a reload carrying
// `area_op=A`, every later mount in that page's life resumed A, ignoring every
// clear and every mint since: so every subsequent "Add treatment area"
// re-asked the resume question about a save that was already over, and held
// Save until she answered. There was no way back to an ordinary form short of
// a full navigation.
//
// WHY A UNIT CONTRACT AND NOT ONLY THE BROWSER CASE. The browser case needs
// the heavy slot and the synthetic-profile gate, so in CI it does not run at
// all. This does, on every PR, and it fails for the right reason: it drives
// the EXACT sequence above through the real `syncAreaOperationParam` against a
// fake address bar, with the router's params FROZEN at A the way a real
// router's are between navigations.
//
// Synthetic ids only. Nothing here corresponds to anything real.

/** v4-shaped, because anything else is refused by design. */
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

const PATH = "/clients/c1/sessions/s1";

/**
 * A fake address bar that behaves like one: `replaceState` moves the URL.
 *
 * `history.state` is carried through, which is what the real call does and
 * what makes the router keep its own idea of the canonical URL — the very
 * thing that made the router's params stale.
 */
function installFakeWindow(search: string): { href: () => string } {
  let href = `http://localhost${PATH}${search ? `?${search}` : ""}`;
  (globalThis as { window?: unknown }).window = {
    get location() {
      return { href };
    },
    history: {
      state: { someRouterState: true },
      replaceState(_state: unknown, _title: string, next: string) {
        href = `http://localhost${next}`;
      },
    },
  };
  return { href: () => href };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("the mount read follows the address bar, not the router", () => {
  it("THE SEQUENCE FROM THE FAILING JOURNEY: a released key must not come back", () => {
    const bar = installFakeWindow(`area_op=${A}`);

    // A RELOAD CARRYING A. Both surfaces agree here, which is why the defect
    // was invisible until something changed the URL client-side.
    const routerParams = new URLSearchParams(`area_op=${A}`);
    expect(
      readAreaOperationIdAtMount(routerParams),
      "the mount did not resume the key the reload actually carried",
    ).toBe(A);

    // START NEW RELEASES IT.
    syncAreaOperationParam(null);
    expect(bar.href()).toBe(`http://localhost${PATH}`);

    // THE NEXT AREA MINTS ITS OWN, SAVES, AND CLEARS.
    syncAreaOperationParam(B);
    expect(bar.href()).toBe(`http://localhost${PATH}?area_op=${B}`);
    syncAreaOperationParam(null);
    expect(bar.href()).toBe(`http://localhost${PATH}`);

    // THE ROUTER HAS NOT MOVED, and that is not a flaw in the fake: no
    // navigation happened, so a real `useSearchParams()` still reports A.
    expect(
      readAreaOperationId(routerParams),
      "the fixture no longer models the staleness this test exists for",
    ).toBe(A);

    // THE ASSERTION. The next Add must mount with NO key.
    expect(
      readAreaOperationIdAtMount(routerParams),
      "the mount resumed a key that was released two writes ago, so every later Add re-asks about a save that is over",
    ).toBeNull();
  });

  it("and it resumes a key the address bar is genuinely still holding", () => {
    // THE OTHER DIRECTION, so the fix is not "always null". An unsettled save
    // that really is open must still be resumable, which is the whole feature.
    const bar = installFakeWindow("");
    syncAreaOperationParam(A);
    expect(bar.href()).toBe(`http://localhost${PATH}?area_op=${A}`);
    expect(
      readAreaOperationIdAtMount(new URLSearchParams("")),
      "an open save in the address bar was not resumed",
    ).toBe(A);
  });

  it("reads the address bar even when the router disagrees", () => {
    // The sharpest form: the two surfaces hold DIFFERENT ids. The address bar
    // is the one the writes went to.
    installFakeWindow(`area_op=${B}`);
    expect(readAreaOperationIdAtMount(new URLSearchParams(`area_op=${A}`))).toBe(
      B,
    );
  });

  it("keeps the address bar's other parameters, and leaves no bare ?", () => {
    const bar = installFakeWindow("tab=sessions");
    syncAreaOperationParam(A);
    expect(bar.href()).toBe(
      `http://localhost${PATH}?tab=sessions&area_op=${A}`,
    );
    syncAreaOperationParam(null);
    expect(bar.href()).toBe(`http://localhost${PATH}?tab=sessions`);
  });

  it("falls back to the ROUTER's params on the server, where there is no address bar", () => {
    // SSR AND FIRST RENDER. `window` is undefined, and the router's params
    // there ARE the request's own — so the server markup and the first client
    // render agree and hydration is unaffected. Returning null instead would
    // render the resumed form as an ordinary one and then change its mind.
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    expect(readAreaOperationIdAtMount(new URLSearchParams(`area_op=${A}`))).toBe(
      A,
    );
    expect(readAreaOperationIdFromLocation()).toBeNull();
  });

  it("still refuses anything it did not mint, from the address bar too", () => {
    // The fail-safe rule is not weakened by changing which surface is read: a
    // crafted or repeated value must read as null so the caller mints, never
    // as a key that could return ANOTHER save's treatment area.
    for (const search of [
      "area_op=not-a-uuid",
      "area_op=",
      `area_op=${A}&area_op=${B}`,
    ]) {
      installFakeWindow(search);
      expect(
        readAreaOperationIdFromLocation(),
        `${search} was honoured as an id we minted`,
      ).toBeNull();
      delete (globalThis as { window?: unknown }).window;
    }
  });
});

describe("and the form does not read this key through the router", () => {
  // WITHOUT THIS THE CONTRACT IS OPTIONAL. The behavioural cases above
  // exercise the helper; nothing in them stops the form going back to
  // `readAreaOperationId(searchParams)`, which is exactly what it did.
  const FORM =
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";
  const src = readFileSync(
    nodePath.resolve(__dirname, "../../..", FORM),
    "utf8",
  );
  // COMMENTS STRIPPED, LINE BEFORE BLOCK: this file explains the defect by
  // name, repeatedly, and a guard reading raw text is tripped by the
  // explanation rather than by the code.
  const code = src
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("resolves the mount key through readAreaOperationIdAtMount", () => {
    expect(code, "the form no longer uses the mount helper").toMatch(
      /readAreaOperationIdAtMount\(/,
    );
  });

  it("and never passes the router's params to the plain reader", () => {
    expect(
      code,
      "the form reads the key from useSearchParams(), which reports the LAST NAVIGATION and not the address bar",
    ).not.toMatch(/readAreaOperationId\s*\(\s*searchParams/);
  });

  it("ANTI-VACUITY: the stripped source is still the form", () => {
    // A comment-stripper that returned "" would satisfy the ban above and
    // prove nothing.
    expect(code).toMatch(/useSearchParams\(\)/);
    expect(code.length).toBeGreaterThan(10_000);
  });
});

describe("positive claim recovery navigation", () => {
  it("refetches the clean destination even when refresh would restore the settled key", () => {
    const bar = installFakeWindow(`area_op=${A}`);
    let canonicalHref = `${PATH}?area_op=${A}`;
    const refresh = () => window.history.replaceState(window.history.state, "", canonicalHref);
    // Negative control: clearing browser history alone cannot fix stale router state.
    syncAreaOperationParam(null);
    refresh();
    expect(readAreaOperationIdFromLocation()).toBe(A);
    // A router navigation receives an explicit destination, not stale canonicalHref.
    const destination = settledAreaOperationHref(A);
    expect(destination).toBe(PATH);
    expect(bar.href()).toContain(`area_op=${A}`); // computing it does not mutate history
    canonicalHref = destination!;
    refresh();
    expect(readAreaOperationIdFromLocation()).toBeNull();
    expect(readAreaOperationIdAtMount(new URLSearchParams(`area_op=${A}`))).toBeNull();
  });

  it("preserves unrelated repeated parameters and the chart anchor", () => {
    const bar = installFakeWindow(`tab=history&tag=a&area_op=${A}&tag=b#capture-2`);
    expect(settledAreaOperationHref(A)).toBe(`${PATH}?tab=history&tag=a&tag=b#capture-2`);
    expect(bar.href()).toContain(`area_op=${A}`);
  });

  it("does not retire a newer operation while the older claim read completes", () => {
    const bar = installFakeWindow(`tab=history&area_op=${A}`);
    syncAreaOperationParam(B);
    expect(settledAreaOperationHref(A)).toBe(`${PATH}?tab=history&area_op=${B}`);
    expect(readAreaOperationIdFromLocation()).toBe(B);
    expect(bar.href()).toContain(`area_op=${B}`);
  });

  it.each(["", "area_op=bad", `area_op=${A}&area_op=${B}`])(
    "preserves an absent or ambiguous current operation: %s", (search) => {
      installFakeWindow(search);
      expect(settledAreaOperationHref(A)).toBe(`${PATH}${search ? `?${search}` : ""}`);
    },
  );

  it("does not let an invalid settled identity clear a current valid key", () => {
    installFakeWindow(`area_op=${B}`);
    expect(settledAreaOperationHref("bad")).toBe(`${PATH}?area_op=${B}`);
  });

  it("cannot navigate outside the browser", () => {
    expect(settledAreaOperationHref(A)).toBeNull();
  });
});

describe("closing a settled or abandoned form only releases its own key", () => {
  it("A settles, B owns the URL, then closing A's saved banner keeps B", () => {
    installFakeWindow(`area_op=${A}`);
    syncAreaOperationParam(B);
    expect(settledAreaOperationHref(A)).toBe(`${PATH}?area_op=${B}`);
    clearAreaOperationParamIfOwned(A);
    expect(readAreaOperationIdFromLocation()).toBe(B);
  });

  it("ordinary abandonment clears its own create key and keeps other URL data", () => {
    const bar = installFakeWindow(`tab=history&area_op=${B}#capture-2`);
    clearAreaOperationParamIfOwned(B);
    expect(bar.href()).toBe(`http://localhost${PATH}?tab=history#capture-2`);
  });

  it("a settings-free form owns no key and cannot clear another operation", () => {
    installFakeWindow(`area_op=${B}`);
    clearAreaOperationParamIfOwned(null);
    expect(readAreaOperationIdFromLocation()).toBe(B);
  });
});
