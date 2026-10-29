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
// 2b. A RELOAD RESUMES A QUESTION, NOT A RETRY.
// ---------------------------------------------------------------------------
describe("a reload resumes a question, not a retry", () => {
  // TWO DEFECTS ARE RECORDED HERE, and the first one shipped in this PR's own
  // first head before Codex and I found it independently (#922 4305312331).
  //
  // ONE: the key survives a reload; the PAYLOAD does not. `draft` and
  // `machineDraft` initialise from fresh defaults, and the key only reaches
  // `create_block_with_initial_setup` inside `initialSetup` — so a save with
  // an empty draft sends NO key, takes the ordinary create path, and makes the
  // duplicate the mechanism exists to prevent. Seeding `saveUnresolved` true
  // made it worse: it FROZE that fresh draft, so she could not reconstruct the
  // payload even in principle, and the screen told her to press Save again.
  //
  // TWO: a reconstructed payload would not help either. 0223 refuses a reused
  // key whose digest differs, so absorption needs a byte-identical payload —
  // which is the "alter a clinical value to get past suppression" shape Sam
  // rejected, arriving from the other side.
  //
  // So the answer is a READ, and these are its rules as a state machine.

  type Resume =
    | { state: "checking" }
    | { state: "saved"; blockId: string }
    | { state: "absent" }
    | { state: "unknown" };

  type Lookup =
    | { ok: true; found: true; blockId: string }
    | { ok: true; found: false }
    | { ok: false; error: string };

  /** The form's own handling of the claim read's three outcomes. */
  const settle = (res: Lookup): { resume: Resume; key: string | null; paramCleared: boolean } => {
    const resumed = UUID_A;
    if (!res.ok) {
      // Adopted even though the answer is unknown: see below.
      return { resume: { state: "unknown" }, key: resumed, paramCleared: false };
    }
    if (res.found) {
      return {
        resume: { state: "saved", blockId: res.blockId },
        key: null,
        paramCleared: true,
      };
    }
    return { resume: { state: "absent" }, key: resumed, paramCleared: false };
  };

  it("CLAIM FOUND: she is told it saved, the parameter is cleared, nothing is re-entered", () => {
    const out = settle({ ok: true, found: true, blockId: "block-1" });
    expect(out.resume).toEqual({ state: "saved", blockId: "block-1" });
    expect(out.paramCleared, "a second reload would re-ask an answered question").toBe(
      true,
    );
    // No key is left live, because there is nothing left to save.
    expect(out.key).toBeNull();
  });

  it("NO CLAIM: nothing committed, so the key is adopted and she saves normally", () => {
    const out = settle({ ok: true, found: false });
    expect(out.resume).toEqual({ state: "absent" });
    expect(out.key, "another reload would no longer be reconcilable").toBe(UUID_A);
  });

  it("READ FAILED: it does not claim she saved, and does not permit a silent duplicate", () => {
    // FAILS SAFE IN BOTH DIRECTIONS. "Not found" and "could not check" are
    // different answers, and collapsing them is how "we do not know" becomes
    // "nothing was saved".
    const out = settle({ ok: false, error: "boom" });
    expect(out.resume).toEqual({ state: "unknown" });
    expect(
      out.key,
      "an unknown outcome minted a fresh key, which duplicates silently if the first attempt committed",
    ).toBe(UUID_A);
  });

  it("and ADOPTING on an unknown read is the safer direction, not the tidier one", () => {
    // If the first attempt HAD committed and she saves anyway, the original
    // key makes 0223 refuse it as a used key with a different payload — she is
    // told. A fresh key would create the duplicate instead. So the unknown
    // case keeps the key for exactly the same reason the absent case does.
    expect(settle({ ok: false, error: "boom" }).key).toBe(
      settle({ ok: true, found: false }).key,
    );
  });

  it("the three outcomes are distinct — none collapses into another", () => {
    const states = [
      settle({ ok: true, found: true, blockId: "b" }).resume.state,
      settle({ ok: true, found: false }).resume.state,
      settle({ ok: false, error: "boom" }).resume.state,
    ];
    expect(new Set(states).size, "two outcomes are indistinguishable").toBe(3);
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
  it("reads the URL once, in CREATE mode only", () => {
    // IN EDIT MODE IT READS NOTHING (Codex, #922 4305312335). This component
    // is dual-mode, and with a stale `area_op` in the URL opening Edit on any
    // area consumed the create operation's key, froze her edits and disabled
    // Cancel — and the edit success path never cleared the parameter, so every
    // later edit stayed poisoned until she navigated away.
    //
    // AND IT READS THE ADDRESS BAR, NOT THE ROUTER (#922, found by browser
    // journey (ii)). `readAreaOperationId(searchParams)` here reported the
    // value from the last real NAVIGATION, so after a reload carrying
    // `area_op=A` every later mount resumed A however many times it had since
    // been released or replaced. `readAreaOperationIdAtMount` reads the
    // surface the writes go to and falls back to the router only on the
    // server. The sequence itself is proved in
    // `area-operation-mount-read.test.ts`; this pins the WIRING.
    const src = read(FORM_SRC);
    expect(src).toMatch(
      /const \[resumedSaveKey\] = useState<string \| null>\(\(\) =>\s*isEdit \? null : readAreaOperationIdAtMount\(searchParams\),?\s*\)/,
    );
  });

  it("does NOT seed the unresolved flag from the URL", () => {
    // The defect group 2b records: seeding it froze a draft built from fresh
    // defaults, so the payload could not be reconstructed and the save sent no
    // key at all (Codex, #922 4305312331).
    const src = read(FORM_SRC);
    expect(src).toMatch(/const \[saveUnresolved, setSaveUnresolved\] = useState\(false\)/);
  });

  it("and answers the resumed question by READING THE CLAIM", () => {
    const src = read(FORM_SRC);
    expect(src).toMatch(/lookupAreaCreateClaimAction\(\{/);
    // All three outcomes handled where they are decided.
    expect(src).toMatch(/setResume\(\{ state: "saved", blockId: res\.blockId \}\)/);
    expect(src).toMatch(/setResume\(\{ state: "absent" \}\)/);
    expect(src).toMatch(/setResume\(\{ state: "unknown" \}\)/);
  });

  it("holds Save for every state that must not commit", () => {
    // Asserted on the TERMS, not the expression, because this list has grown
    // twice and pinning its exact text is how a guard reds on a change that
    // strengthens it.
    //
    //   pending   — a save already in flight;
    //   checking  — the claim read has not landed, and committing before it
    //               does is the one outcome that must not happen;
    //   saved     — positively answered, so there is nothing left to save;
    //   resumedNeedsSettings — a resumed save with an EMPTY draft would send
    //               NO key and duplicate (Codex, #922 4305550889).
    const src = read(FORM_SRC);
    const save = /onClick=\{submit\}[\s\S]{0,400}?disabled=\{([\s\S]*?)\}\s*\n\s*data-testid="save-treatment-area"/.exec(
      src,
    );
    expect(save, "the Save button's disabled expression was not found").toBeTruthy();
    for (const term of [
      "pending",
      'resume.state === "checking"',
      'resume.state === "saved"',
      "resumedNeedsSettings",
    ]) {
      expect(save![1], `Save is not held for ${term}`).toContain(term);
    }
  });

  it("a resumed settings-free save is HELD, because it cannot reproduce her settings", () => {
    // THIS REVERSES 4305550889's REMEDY AND KEEPS ITS CLAIM (ops01's ruling on
    // #922 4307515255).
    //
    // That finding was right that a bare save from a reloaded form must not
    // proceed UNKEYED - it took the ordinary create path and made a second
    // area. The remedy was to BLOCK such a save. But blocking it is what made
    // closing discard the key (4305701038), and discarding the key is how an
    // unsettled save came to be duplicable (4307515255). The three findings
    // are one knot.
    //
    // UNTIED BY LETTING THE KEY TRAVEL WITHOUT SETTINGS, which 0223 already
    // permits: the settings half is nullable, "null/empty means no settings
    // to record, which is a valid save", and the claim is still written. So
    // the save proceeds KEYED, and is absorbed or refused rather than
    // duplicating.
    //
    // ONLY ON HER EXPLICIT CHOICE. A key used silently would absorb an area
    // she meant to create as a second one, which Sam's standing requirement
    // forbids - recovery must preserve the ability to make an identical
    // second area deliberately.
    // AND THE REASON IS NOT THE ONE 4305550889 GAVE, which I repeated until a
    // browser test would not write. "It would go unkeyed" was fixable: 0223's
    // settings half is nullable and it still writes the claim, so a bare save
    // CAN carry the key. What cannot be fixed is that a settings-free save
    // reproduces NO settings - so if the original never committed, which is
    // what `absent` usually means, it creates an area missing everything she
    // typed before the reload.
    //
    // THE KEYED BARE-SAVE PATH WAS WRITTEN AND REMOVED WITHOUT RUNNING. It is
    // banned by name so it cannot come back as an apparent simplification.
    const src = read(FORM_SRC);
    expect(
      src,
      "the keyed settings-free save is back, and it can create a settings-less area",
    ).not.toMatch(/groups: \[\],/);
    expect(src).not.toMatch(/machineId: null,/);
    // THE HOLD IS WHAT STANDS IN ITS PLACE, and the way back is the choice.
    expect(src).toMatch(/const machineSetupForSave = \(\) => \{\s*\n\s*const chosen = machineDraft;\s*\n\s*if \(!chosen \|\| chosen\.groups\.length === 0\) return null;/);
  });

  it("and the choice is EXPLICIT, never inferred from the values", () => {
    // SAM'S STANDING REQUIREMENT. Absorbing by value would suppress an
    // intentionally identical second area, and nothing here may ask her to
    // change a clinical value to get one.
    const src = read(FORM_SRC);
    expect(src).toMatch(/RESUME_CHOICE_PROMPT/);
    expect(src).toMatch(/data-testid="initial-save-resume-choice"/);
    expect(src).toMatch(/data-testid="initial-save-resume-choice-resume"/);
    expect(src).toMatch(/data-testid="initial-save-resume-choice-new"/);
    // SAVE IS HELD WHILE IT IS UNANSWERED: saving first would decide it for
    // her, either absorbing an area she meant to create or duplicating one
    // she did not.
    expect(src).toMatch(/resumeChoicePending \|\|/);
    // AND "START NEW" RELEASES THE KEY, which is what makes a second area
    // possible without touching a recorded value.
    expect(src).toMatch(
      /const chooseStartNew = \(\) => \{\s*\n\s*setResumeChoice\("new"\);\s*\n\s*setPendingSaveKey\(null\);/,
    );
  });

  it("the needs-settings hold now applies only to a chosen RESUME", () => {
    // THE P1 ITSELF (Codex, #922 4305550889). The retry key only reaches
    // `create_block_with_initial_setup` inside `initialSetup`, so a bare save
    // from a freshly reloaded form sent no key, took the ordinary create path
    // and made a second area. Keeping the key through draft changes — the
    // previous round's fix — cannot help when there is no `initialSetup` for
    // it to travel in.
    //
    // Requiring settings follows from what the parameter MEANS: `area_op` is
    // only ever minted inside `machineSetupForSave`, so a resumed operation
    // always had settings, and a bare save in that state is a different save.
    const src = read(FORM_SRC);
    const expr = /const resumedNeedsSettings =\s*([^;]*);/.exec(src);
    expect(expr, "the resumed-needs-settings rule was not found").toBeTruthy();
    // NARROWED, not removed. The hold existed because a bare save went
            // unkeyed; it now goes KEYED when she resumes, so what is left to
            // hold is the case where she has chosen RESUME and there is
            // genuinely nothing to send yet.
    expect(expr![1]).toContain("resumeUnsettled");
    expect(expr![1]).toContain('resumeChoice === "resume"');
    expect(expr![1]).toContain("!hasSettingsToSend");

    // Derived from the draft, NOT from `machineSetupForSave()` — that
    // function mints and stores a key, so calling it during render would set
    // state from a render pass.
    const has = /const hasSettingsToSend =\s*([^;]*);/.exec(src);
    expect(has, "the settings predicate was not found").toBeTruthy();
    expect(has![1]).toContain("machineDraft");
    expect(has![1]).not.toContain("machineSetupForSave");

    // And she is told why, rather than facing a dead button.
    expect(src).toMatch(/INITIAL_SAVE_RESUME_NEEDS_SETTINGS/);
    expect(src).toMatch(/data-testid="initial-save-resume-needs-settings"/);
  });

  it("clears the parameter on EVERY exit, and never in edit mode", () => {
    // Cancel on a definitive error used to leave `area_op` behind, so the next
    // Add treated an abandoned attempt as an open save (Codex, #922
    // 4305312340). In edit mode it clears nothing, because the parameter is
    // not this form's to discard — and nor does it while the resumed
    // operation still owns the key, because that identity is the only thing
    // that can reconcile a save which may have committed (4305431336).
    const src = read(FORM_SRC);
    const close = /if \(([^)]*)\) \{\s*clearAreaOperationParamIfOwned\(resume.state === "saved" \? resumedSaveKey : pendingSaveKey\);\s*\}\s*onCancel\(\);/.exec(
      src,
    );
    expect(close, "the form's exit path was not found").toBeTruthy();
    expect(close![1]).toContain("!isEdit");

    // CLOSING IS AN EXPLICIT ABANDONMENT, and this assertion REVERSED once
    // (Codex, #922 4305701038). It used to require `!resumeOwnsKey`, i.e.
    // preserve the key whenever a resumed operation owned it — which turned
    // the form's own instruction into a trap: the on-screen line tells her to
    // close when the settings did not survive the reload, and closing then
    // left `area_op` behind, so every later Add resumed the abandoned
    // operation and `resumedNeedsSettings` blocked an ordinary settings-free
    // save. No way back to a fresh area short of editing the URL.
    //
    // The narrower exception is what the earlier finding (4305431336) was
    // actually about: closing while the lookup is IN FLIGHT would discard an
    // answer one round trip away.
    // AND IT HAS NOW REVERSED BACK (Codex, #922 4307515255). The narrow
    // `checking` test was too narrow: `absent` is not settled either, because
    // the command takes its advisory lock BEFORE the claim lookup and writes
    // the claim at the very END, so a read landing mid-commit sees no row for
    // a save that is about to succeed. Clearing on that answer discarded the
    // only identity that could absorb the original.
    //
    // WHAT MAKES THE REVERSAL SAFE THIS TIME is that 4305701038's trap is
    // closed elsewhere rather than by discarding the key: a resumed
    // settings-free save now CARRIES the key through
    // `create_block_with_initial_setup` with null groups, so retaining it no
    // longer blocks the way back to a fresh area - and the explicit recovery
    // choice means a retained key is never used to absorb silently.
    expect(
      close![1],
      "closing clears a key the resumed operation still owns, which is how an unsettled save became duplicable",
    ).toContain("!resumeOwnsKey");
    expect(
      close![1],
      "the narrow checking-only test is back, and absent is unsettled too",
    ).not.toContain('resume.state !== "checking"');
    expect(
      (src.match(/onCancel\(\)/g) ?? []).length,
      "an exit path still calls onCancel directly, bypassing the parameter clear",
    ).toBe(1);
    expect((src.match(/closeForm\b/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it("does not drop the key while the RESUMED OPERATION owns it", () => {
    // Two paths threw the resumed key away, and both read the UNKNOWN state
    // as settled when it is the least settled state there is.
    //
    //   * the collector reports an EMPTY draft on mount, which arrives before
    //     the read resolves, so the drop would clear the parameter for the
    //     width of the round trip;
    //   * entering any machine reading after a FAILED read fired the same drop
    //     and cleared the key that had just been adopted so a later save could
    //     not silently duplicate — the reconstructed save then minted a fresh
    //     uuid and bypassed the claim entirely (Codex, #922 4305431332, P1).
    const src = read(FORM_SRC);
    const drop = /if \(([^)]*)\) setPendingSaveKey\(null\)/.exec(src);
    expect(drop, "the draft-change drop site was not found").toBeTruthy();
    expect(drop![1]).toContain("!saveUnresolved");
    expect(drop![1]).toContain("!resumeOwnsKey");
  });

  it("OWNERSHIP, state by state: only a POSITIVE answer releases the key", () => {
    // TWO P1s LIVE IN THIS TABLE, both from treating a non-answer as settled.
    //
    //   * `unknown` — a read that FAILED (4305431332). Adopting the key there
    //     is worthless if the next keystroke discards it.
    //   * `absent` — a read that returned no row (4305501015). 0223 takes its
    //     advisory lock BEFORE the claim lookup and inserts the claim at the
    //     END, so a reload landing mid-commit sees no row for a save that is
    //     about to succeed. "Not found yet" is not "not saved".
    //
    // Only `saved` is positively true, and it is the state where the form
    // closes anyway. `idle` is the ordinary non-resumed form, where a changed
    // draft still mints a new key as it always did.
    const owns = (state: string) => state !== "idle" && state !== "saved";
    expect(owns("checking"), "the read is in flight").toBe(true);
    expect(owns("absent"), "a negative read can race the original commit").toBe(
      true,
    );
    expect(owns("unknown"), "an unanswerable read is not an answer").toBe(true);
    expect(owns("saved"), "a positive answer releases it").toBe(false);
    expect(owns("idle"), "an ordinary form owns no resumed key").toBe(false);

    // And the form implements exactly that exclusion — asserted on which
    // states are EXCLUDED, not on the operator order.
    const src = read(FORM_SRC);
    const expr = /const resumeOwnsKey =\s*([^;]*);/.exec(src);
    expect(expr, "the resumed-ownership rule was not found").toBeTruthy();
    expect(expr![1]).toContain('!== "idle"');
    expect(expr![1]).toContain('!== "saved"');
    expect(
      expr![1],
      "a resumed state other than 'saved' stopped owning the key",
    ).not.toMatch(/=== "(checking|absent|unknown)"/);
  });

  it("a FOUND claim navigates to the current settled URL and refetches the chart", () => {
    const src = read(FORM_SRC);
    const found = src.slice(src.indexOf("if (res.found)"), src.indexOf("// NOTHING COMMITTED."));
    expect(found).toContain("settledAreaOperationHref(resumedSaveKey)");
    expect(found).toContain("router.replace(settledHref, { scroll: false })");
    expect(found.indexOf("router.replace(")).toBeLessThan(found.indexOf('setResume({ state: "saved"'));
    expect(found).not.toContain("router.refresh()");
    expect(found).not.toContain("syncAreaOperationParam(null)");
  });

  it("and the ABANDONMENT path is actually reachable", () => {
    // The fix is worthless if Cancel is disabled in the state she is told to
    // use it from. Cancel is held for `checking` only, so in `absent` and
    // `unknown` — the states that show the re-enter-or-close line — it is
    // live, and closing clears the key.
    const src = read(FORM_SRC);
    const cancel = /disabled=\{([^}]*)\}\s*\n\s*data-testid="cancel-treatment-area"/.exec(
      src,
    );
    expect(cancel, "the Cancel button's disabled expression was not found").toBeTruthy();
    expect(cancel![1]).toContain('resume.state === "checking"');
    for (const state of ["absent", "unknown"]) {
      expect(
        cancel![1],
        `Cancel is disabled in ${state}, where the form tells her to close`,
      ).not.toContain(`resume.state === "${state}"`);
    }
    // And the line she reads says what closing costs.
    expect(src).toMatch(/INITIAL_SAVE_RESUME_NEEDS_SETTINGS/);
  });

  it("and Cancel waits for a lookup that is already in flight", () => {
    // Dismissing the form mid-read discards the answer; the read is one round
    // trip (Codex, #922 4305431336).
    const src = read(FORM_SRC);
    const cancel = /disabled=\{([^}]*)\}\s*\n\s*data-testid="cancel-treatment-area"/.exec(
      src,
    );
    expect(cancel, "the Cancel button's disabled expression was not found").toBeTruthy();
    expect(cancel![1]).toContain('resume.state === "checking"');
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
    // Nothing may reach the raw setter except the shadow itself — including
    // the resumed key's adoption, which goes through `setPendingSaveKey` so
    // this invariant stays true as the paths multiply.
    expect(
      (src.match(/setPendingSaveKeyRaw\(/g) ?? []).length,
      "something bypasses the URL-syncing setter",
    ).toBe(1);
    expect(src).toMatch(/if \(resumedSaveKey !== null\) setPendingSaveKey\(resumedSaveKey\)/);
  });

  it("and every existing drop site still goes through the shadow", () => {
    // Both drops — a changed draft, and a save that closed — and the mint.
    // Asserted as a count rather than by location so moving them does not
    // red this, but removing one does.
    const src = read(FORM_SRC);
    expect(src).toMatch(/const key = pendingSaveKey \?\? crypto\.randomUUID\(\)/);
    // THREE NOW: a changed draft, a save that closed, and "start a new area"
    // - which releases the retained key so an identical second area is
    // possible without touching a recorded value.
    expect(
      (src.match(/setPendingSaveKey\(null\)/g) ?? []).length,
      "a drop site stopped clearing the URL",
    ).toBe(3);
    // And the form's exits clear it directly, which `closeForm` owns.
    expect(src).toMatch(/clearAreaOperationParamIfOwned\(resume.state === "saved" \? resumedSaveKey : pendingSaveKey\)/);
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

// ---------------------------------------------------------------------------
// 6. THE CLAIM READ'S SAFETY PROPERTIES.
//
// ASSERTED ON SOURCE BECAUSE THE DATABASE PROOF HAS NOT RUN. The RLS scoping
// and the cross-studio denial are a DB test (written, queued for the shared
// slot); these pin the properties that test would otherwise be the only
// evidence for, so a regression is caught in the unit lane rather than waiting
// for a lane that needs a Postgres.
// ---------------------------------------------------------------------------
describe("the claim read is scoped, and a failed read is not an empty one", () => {
  const ACTIONS_SRC =
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts";

  /** `lookupAreaCreateClaimAction`'s own body. */
  const lookup = () => {
    const src = read(ACTIONS_SRC);
    const i = src.indexOf("export async function lookupAreaCreateClaimAction");
    expect(i, "the claim read is gone").toBeGreaterThan(-1);
    return src.slice(i);
  };

  it("reads through the AUTHENTICATED client, never the service role", () => {
    // The row is scoped by `treatment_area_create_claims_member_select`, which
    // is `using (is_studio_member(studio_id))`. Reading as the service role
    // would bypass it and make this lookup a cross-studio oracle for "does
    // this session hold a claim under this key".
    const body = lookup();
    expect(body).toMatch(/await createClient\(\)/);
    expect(
      body,
      "the claim read reached for an admin client, which bypasses the policy",
    ).not.toMatch(/createAdminClient|service_role|SERVICE_ROLE/);
  });

  it("binds the session in the QUERY, and the route's lineage before it", () => {
    const body = lookup();
    expect(body).toMatch(/\.eq\("session_id", sessionId\)/);
    expect(body).toMatch(/\.eq\("idempotency_key", idempotencyKey\)/);
    // Studio membership is not enough on its own: without this, a key could be
    // probed against another CLIENT's chart inside the same studio.
    expect(body).toMatch(
      /assertSessionForClient\(scope\.studioId, clientId, sessionId\)/,
    );
  });

  it("A FAILED READ IS NOT AN EMPTY RESULT", () => {
    // PostgREST reports both as a falsy `data`. Collapsing them is how "we
    // could not check" becomes "nothing was saved" — and then a duplicate.
    const body = lookup();
    expect(body).toMatch(/if \(error\) \{\s*return \{ ok: false/);
    expect(body).toMatch(/if \(!data\) return \{ ok: true, found: false \}/);
  });

  it("refuses a key we did not mint rather than answering either way", () => {
    expect(lookup()).toMatch(/if \(!isAreaOperationId\(idempotencyKey\)\)/);
  });

  it("and an unauthenticated caller is refused, not told 'not found'", () => {
    // "Not found" would invite a fresh save under a key whose history nobody
    // checked.
    expect(lookup()).toMatch(/if \(!scope\) \{\s*return \{ ok: false/);
  });
});
