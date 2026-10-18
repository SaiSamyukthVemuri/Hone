import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

import {
  AREA_OP_PARAM,
  areaOperationSearch,
  isAreaOperationId,
  readAreaOperationId,
} from "@/lib/machines/area-operation";
import { redactVercelAnalyticsUrl } from "@/lib/analytics/vercel-url-redaction";

// ===========================================================================
// A1 — THE INITIAL SAVE'S RETRY KEY SURVIVES A RELOAD.
//
// THE DEFECT (Codex #860 4302218408). The key lived only in React state, so a
// reload, a tab close or browser Back discarded it. A save that had COMMITTED
// and only lost its answer then became a SECOND treatment area when she
// re-entered the same settings.
//
// WHAT THIS IS NOT. The first attempt matched claims by payload digest, and
// Sam rejected it: payload equality cannot tell a lost retry apart from a
// second area she MEANT to create, and the only escape it left was to alter a
// clinical value. The hard rule is that she must never have to change a
// clinical value to get past duplicate suppression, and the first group below
// is that rule written as an assertion.
//
// WHAT THIS FILE CANNOT PROVE. These are pure functions plus source
// contracts. There is no DOM here and no database: the browser behaviour —
// that an actual reload replays the actual id and that 0223 actually absorbs
// it — is an e2e and a DB proof, neither of which has run. What is proved
// here is the id's RULES and that the form is wired to them.
// ===========================================================================

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-9222-222222222222";

const read = (rel: string) =>
  readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8").replace(
    /^\s*(\/\/|\*|\/\*).*$/gm,
    " ",
  );

const FORM_SRC =
  "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx";
const AREA_OP_SRC = "lib/machines/area-operation.ts";

/**
 * The retry key a form open at `search` would use — the form's OWN rule.
 *
 * It is `pendingSaveKey ?? crypto.randomUUID()` with the held key seeded from
 * the URL, which is exactly the expression `block-setup-form.tsx` evaluates
 * and which group 5 pins in that file by source contract. Modelled here with
 * an injected `mint` so the two outcomes are DETERMINISTIC: an earlier draft
 * of this test compared two `Math.random()` values and so asserted nothing
 * about the id at all.
 */
const keyForOpen = (search: string | null, mint: () => string) =>
  readAreaOperationId(search) ?? mint();

/** A mint whose output says which call produced it. */
function counter(): () => string {
  let n = 0;
  return () => `minted-${++n}`;
}

// ---------------------------------------------------------------------------
// 1. SAM'S RULE, AS AN ASSERTION.
// ---------------------------------------------------------------------------
describe("a deliberate second identical area is still TWO areas", () => {
  it("a fresh form carries NO id, so a byte-identical second save is a different save", () => {
    // THE RULE (Sam): she must never have to change a clinical value to get
    // past duplicate suppression. A fresh form open has no `area_op`, so it
    // mints its own id and the save is its own save — no matter how identical
    // the values are. This is the test #920's payload-digest matching could
    // not pass, and it is why the id is carried rather than inferred.
    //
    // The form is open at the plain session URL both times: same path, same
    // (absent) parameter, byte-identical payload. Nothing distinguishes the
    // two saves EXCEPT that each minted its own id.
    const mint = counter();
    const freshUrl = "?tab=chart";
    expect(keyForOpen(freshUrl, mint)).toBe("minted-1");
    expect(keyForOpen(freshUrl, mint)).toBe("minted-2");
  });

  it("CONTRAST: the same two opens with a CARRIED id are ONE save", () => {
    // The other half of the rule, and what makes the test above meaningful:
    // the mechanism is not simply minting every time. A carried id is reused
    // and the mint is never reached, so 0223 answers the second attempt with
    // the first one's area.
    const mint = counter();
    const carried = `?${AREA_OP_PARAM}=${UUID_A}`;
    expect(keyForOpen(carried, mint)).toBe(UUID_A);
    expect(keyForOpen(carried, mint)).toBe(UUID_A);
    // The mint was never called, so nothing was minted to collide with.
    expect(mint()).toBe("minted-1");
  });

  it("and nothing about the clinical payload is consulted to decide that", () => {
    // The module must have no notion of a payload at all. If a value ever
    // became part of this decision, the rule above would be re-openable by
    // the same reasoning #920 was rejected for.
    const src = read(AREA_OP_SRC);
    expect(src).not.toMatch(/digest|payload|readings|groups|values/i);
  });
});

// ---------------------------------------------------------------------------
// 2. RELOAD AND BACK REPLAY THE SAME ID.
// ---------------------------------------------------------------------------
describe("a reload and a Back replay the same id", () => {
  it("reads the id the URL is carrying", () => {
    // A reload re-renders at the same URL, and Back lands on a history entry
    // whose URL carries it. Both reduce to this one question, which is why
    // the id lives in the URL rather than in state.
    expect(readAreaOperationId(`?${AREA_OP_PARAM}=${UUID_A}`)).toBe(UUID_A);
  });

  it("reads it beside unrelated parameters, in any position", () => {
    expect(readAreaOperationId(`?tab=chart&${AREA_OP_PARAM}=${UUID_A}`)).toBe(
      UUID_A,
    );
    expect(readAreaOperationId(`?${AREA_OP_PARAM}=${UUID_A}&tab=chart`)).toBe(
      UUID_A,
    );
  });

  it("round-trips: what the URL is given is what a reload reads back", () => {
    // The pair has to compose, or the id survives being written and not being
    // read — the failure that would be invisible until a real lost response.
    const search = areaOperationSearch("?tab=chart", UUID_A);
    expect(readAreaOperationId(search)).toBe(UUID_A);
    expect(new URLSearchParams(search).get("tab")).toBe("chart");
  });

  it("replaces rather than appends, so a re-mint cannot leave two", () => {
    // A changed draft mints a new id. Appending would leave the parameter
    // REPEATED, which `readAreaOperationId` then refuses to read at all — so
    // the next reload would mint again and the absorption would be lost
    // silently.
    const search = areaOperationSearch(`?${AREA_OP_PARAM}=${UUID_A}`, UUID_B);
    expect(new URLSearchParams(search).getAll(AREA_OP_PARAM)).toEqual([UUID_B]);
    expect(readAreaOperationId(search)).toBe(UUID_B);
  });

  it("removes the parameter when the save closes, leaving no bare '?'", () => {
    // The id exists only while a save is open. Leaving it behind would make
    // the NEXT form open reuse it — and that would break the rule in group 1
    // by absorbing a deliberate second area.
    expect(areaOperationSearch(`?${AREA_OP_PARAM}=${UUID_A}`, null)).toBe("");
    expect(areaOperationSearch(`?tab=chart&${AREA_OP_PARAM}=${UUID_A}`, null)).toBe(
      "tab=chart",
    );
  });
});

// ---------------------------------------------------------------------------
// 2b. THE RESUMED KEY SURVIVES THE COLLECTOR'S MOUNT REPORT.
// ---------------------------------------------------------------------------
describe("the resumed key survives the collector's mount report", () => {
  // A DEFECT THIS FEATURE HAD BEFORE IT SHIPPED, caught by reading the mount
  // path rather than by any test here. Carrying the key in the URL is not
  // enough on its own:
  //
  //   * `MachineSettingDraft` reports an EMPTY draft on mount;
  //   * the form's `onSettingDraftChanged` drops the open key on a draft
  //     change UNLESS a save is unresolved;
  //   * after a reload `saveUnresolved` is a fresh `false`.
  //
  // So the key recovered from the URL was dropped by the collector's own
  // mount report, before she could press Save — on exactly the path the
  // resume exists to serve, and with nothing on screen to say so.
  //
  // The fix is that the parameter's presence restores BOTH: the parameter is
  // there if and only if a save is open and unresolved.

  /** What a page load resumes from the URL — the form's two seeds. */
  const resume = (search: string | null) => {
    const key = readAreaOperationId(search);
    return { key, unresolved: key !== null };
  };

  /** `onSettingDraftChanged`: a draft change drops the open key, unless unresolved. */
  const afterMountReport = (st: { key: string | null; unresolved: boolean }) =>
    st.unresolved ? st : { ...st, key: null };

  const carried = `?${AREA_OP_PARAM}=${UUID_A}`;

  it("resuming restores the UNRESOLVED flag as well as the key", () => {
    expect(resume(carried)).toEqual({ key: UUID_A, unresolved: true });
  });

  it("so the mount report cannot drop it", () => {
    expect(afterMountReport(resume(carried)).key).toBe(UUID_A);
  });

  it("THE DEFECT: restoring the key WITHOUT the flag loses it on mount", () => {
    // The state the form was in when the key alone was seeded. This is the
    // assertion that would have caught it, and it is kept as the record of
    // why both are seeded from one read rather than one of them.
    const keyOnly = { key: readAreaOperationId(carried), unresolved: false };
    expect(keyOnly.key).toBe(UUID_A);
    expect(
      afterMountReport(keyOnly).key,
      "the key survived without the flag, so this control proves nothing",
    ).toBeNull();
  });

  it("CONTROL: a fresh open has no key and nothing to lose", () => {
    expect(resume("?tab=chart")).toEqual({ key: null, unresolved: false });
    expect(afterMountReport(resume("?tab=chart")).key).toBeNull();
  });

  it("CONTROL: a malformed id does not resume an unresolved save either", () => {
    // Otherwise a crafted URL would freeze her draft and disable Cancel on a
    // save that never happened.
    expect(resume(`?${AREA_OP_PARAM}=junk`)).toEqual({
      key: null,
      unresolved: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 3. FAILS SAFE BY MINTING, NEVER BY REUSING A GUESS.
// ---------------------------------------------------------------------------
describe("a missing or malformed id mints a new one, never a guess", () => {
  // WHY THE DIRECTIONS ARE NOT SYMMETRIC. Minting an unnecessary id costs at
  // worst one extra area she can delete. Honouring a value we did NOT mint
  // can have 0223 return another save's treatment area for this one — the
  // claim is unique on `(session_id, idempotency_key)` and does not care
  // where the key came from.
  const REFUSED: Array<[string, string]> = [
    ["absent", "?tab=chart"],
    ["empty search", ""],
    ["empty value", `?${AREA_OP_PARAM}=`],
    ["not a uuid", `?${AREA_OP_PARAM}=hello`],
    ["truncated", `?${AREA_OP_PARAM}=11111111-1111-4111-8111`],
    ["v1-shaped, not v4", `?${AREA_OP_PARAM}=11111111-1111-1111-8111-111111111111`],
    [
      "wrong variant nibble",
      `?${AREA_OP_PARAM}=11111111-1111-4111-7111-111111111111`,
    ],
    ["trailing junk", `?${AREA_OP_PARAM}=${UUID_A}x`],
    ["a sql-ish string", `?${AREA_OP_PARAM}=' or 1=1--`],
    ["REPEATED, even when both are valid", `?${AREA_OP_PARAM}=${UUID_A}&${AREA_OP_PARAM}=${UUID_B}`],
    ["repeated with one valid", `?${AREA_OP_PARAM}=${UUID_A}&${AREA_OP_PARAM}=junk`],
  ];

  for (const [label, search] of REFUSED) {
    it(`refuses to read ${label}`, () => {
      expect(readAreaOperationId(search)).toBeNull();
    });
  }

  it("refuses null and undefined rather than throwing", () => {
    expect(readAreaOperationId(null)).toBeNull();
    expect(readAreaOperationId(undefined)).toBeNull();
  });

  it("CONTROL: a well-formed id IS read, so the refusals above are not vacuous", () => {
    // Without this, every assertion in this group would also pass if the
    // reader simply always returned null.
    expect(readAreaOperationId(`?${AREA_OP_PARAM}=${UUID_A}`)).toBe(UUID_A);
    expect(isAreaOperationId(UUID_A)).toBe(true);
  });

  it("and a malformed id can never be WRITTEN to the URL either", () => {
    // The reader refusing a malformed value is only half of it: if we could
    // write one, a later reader would mint instead and the save would lose
    // its absorption with nothing on screen to say so.
    expect(() => areaOperationSearch("", "not-a-uuid")).toThrow();
    expect(() => areaOperationSearch("", UUID_A)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. THE ID NEVER REACHES ANALYTICS.
// ---------------------------------------------------------------------------
describe("the analytics boundary drops the id", () => {
  const SESSION_URL =
    "https://hone.care/clients/0a4c9e3e-2b1f-4d7a-9c11-5e8f6a2b3c4d" +
    "/sessions/7f3b1d2e-9a4c-4e6b-8d15-2c7a9b4e6f81";

  it("drops ?area_op from an authenticated app URL", () => {
    // G-07's boundary drops the whole query string for an app route — the
    // parameter is not individually allow-listed and must not become so. A
    // treatment-area operation id next to a client and session identifier is
    // exactly the shape that boundary exists to stop.
    const out = redactVercelAnalyticsUrl(`${SESSION_URL}?${AREA_OP_PARAM}=${UUID_A}`);
    expect(out).not.toBeNull();
    expect(out, "the operation id reached the analytics provider").not.toContain(
      AREA_OP_PARAM,
    );
    expect(out, "the id's value reached the analytics provider").not.toContain(
      UUID_A,
    );
    expect(out).not.toContain("?");
  });

  it("and the id is the only thing added to that URL, so nothing else leaks with it", () => {
    // The redacted form is identical with and without the parameter: adding
    // it changed the event not at all.
    expect(
      redactVercelAnalyticsUrl(`${SESSION_URL}?${AREA_OP_PARAM}=${UUID_A}`),
    ).toBe(redactVercelAnalyticsUrl(SESSION_URL));
  });

  it("CONTROL: the boundary does redact, and the uuid segments go too", () => {
    // Proves the assertions above are not passing because the boundary
    // returned something empty or unrelated.
    expect(redactVercelAnalyticsUrl(SESSION_URL)).toBe(
      "https://hone.care/clients/[id]/sessions/[id]",
    );
  });

  it("CONTROL: a marketing URL keeps its reviewed attribution params", () => {
    // The marketing branch is the one path that preserves a query string, so
    // it is the one that could have carried the id. It is a different route
    // family entirely, and the form never renders there — but asserting it
    // here is what makes "the query string is dropped" a claim about THIS
    // boundary rather than about one branch of it.
    const mkt = redactVercelAnalyticsUrl(
      `https://hone.care/?utm_source=x&${AREA_OP_PARAM}=${UUID_A}`,
    );
    expect(mkt).not.toBeNull();
    expect(mkt, "the id survived the marketing sanitizer").not.toContain(
      AREA_OP_PARAM,
    );
    expect(mkt).not.toContain(UUID_A);
  });
});

// ---------------------------------------------------------------------------
// 5. THE FORM IS ACTUALLY WIRED TO ALL OF IT.
// ---------------------------------------------------------------------------
describe("the create form carries the key in the URL", () => {
  it("seeds the retry key FROM the URL, through ONE read", () => {
    // Without this the id is written and never read, and the reload it exists
    // for still duplicates — the lane's most repeated defect is a value that
    // exists, is correct, and never arrives.
    const src = read(FORM_SRC);
    expect(src).toMatch(
      /const \[resumedSaveKey\] = useState<string \| null>\(\(\) =>\s*readAreaOperationId\(searchParams\),?\s*\)/,
    );
    expect(src).toMatch(
      /useState<string \| null>\(\s*resumedSaveKey,?\s*\)/,
    );
  });

  it("and seeds the UNRESOLVED flag from the same read", () => {
    // Seeding the key alone is the defect group 2b records: the collector's
    // mount report drops an open key unless a save is unresolved, so the key
    // was recovered and then immediately discarded.
    const src = read(FORM_SRC);
    expect(src).toMatch(
      /useState\(\s*\(\) => resumedSaveKey !== null,?\s*\)/,
    );
  });

  it("and mirrors it back AT THE SETTER, not at the call sites", () => {
    // The key is minted in one place and dropped in two, and the mechanism
    // fails silently if any one of them forgets the URL. Shadowing the setter
    // is the same answer this file already uses for `setDraft` and the same
    // one `canEditDraft(state, inFlight)` reached from the other direction:
    // the structure carries the rule rather than every caller remembering it.
    const src = read(FORM_SRC);
    expect(src).toMatch(
      /const setPendingSaveKey = \(next: string \| null\) => \{\s*setPendingSaveKeyRaw\(next\);\s*syncAreaOperationParam\(next\);\s*\}/,
    );
    // Nothing may reach the raw setter except the shadow itself.
    expect(
      (src.match(/setPendingSaveKeyRaw\(/g) ?? []).length,
      "something bypasses the URL-syncing setter",
    ).toBe(1);
  });

  it("and every existing drop site still goes through the shadow", () => {
    // Both drops — a changed draft, and a save that closed — and the mint.
    // Asserted as a count rather than by location so moving them does not
    // red this, but removing one does.
    const src = read(FORM_SRC);
    expect(src).toMatch(/if \(!saveUnresolved\) setPendingSaveKey\(null\)/);
    expect(src).toMatch(/const key = pendingSaveKey \?\? crypto\.randomUUID\(\)/);
    expect(
      (src.match(/setPendingSaveKey\(null\)/g) ?? []).length,
      "a drop site stopped clearing the URL",
    ).toBe(2);
  });

  it("writes through replaceState, never the router", () => {
    // `router.replace` would re-render the route and refetch the server
    // component in the middle of an outstanding save. This only edits the
    // current history entry, which is all a value read once at mount needs.
    const src = read(AREA_OP_SRC);
    expect(src).toMatch(/window\.history\.replaceState\(/);
    expect(src).not.toMatch(/router\.(replace|push)/);
  });

  it("and is a no-op on the server, so a render cannot touch history", () => {
    const src = read(AREA_OP_SRC);
    expect(src).toMatch(/typeof window === "undefined"\) return/);
  });
});
