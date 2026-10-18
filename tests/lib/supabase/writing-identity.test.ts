import { readFileSync } from "node:fs";
import nodePath from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

// ===========================================================================
// A PRE-WRITE IDENTITY REFUSAL IS DEFINITIVE (Codex, #860 4308620484/87)
// ===========================================================================
//
// THE DEFECT. `getCurrentPractitionerWithStudio()` THROWS on two controlled
// refusals — a membership that is no longer active, and two or more
// memberships with no valid studio selection — and it throws BEFORE any RPC,
// so nothing is written. But the two callers that hold a retry key map EVERY
// throw to an unknown outcome: the create form's catch returns `unresolved`
// whenever settings are attached, and `machine-reading-entry`'s catch returns
// `{ kind: "unknown" }`.
//
// Unknown is right for a lost response and wrong here. It freezes the draft,
// the machine and mode pickers and Cancel, and keeps the retry key — and
// because the refusal happens before the write, every retry meets the SAME
// refusal. The state can never settle: a form she can neither save nor
// dismiss.
//
// WHAT IS ASSERTED, AND ONE CORRECTION TO THE BRIEF. "The key released and
// controls unfrozen" is exactly right for the create site. For the REVISION
// site the key is deliberately RETAINED on a refusal — `afterOutcome`'s
// `refused` branch keeps it, because a refusal is an acknowledged NON-write
// and retrying the same key is correct — and `afterDraftChanged` drops it the
// moment she edits. So the load-bearing claim is `unresolved: false`, which is
// what unfreezes everything. Asserting a released key there would be asserting
// something false.
//
// Synthetic identities only. Nothing here corresponds to anything real.

// THE ERROR TYPE LIVES IN ITS OWN MODULE, which is why this import is free of
// setup. `queries.ts` pulls in react's `cache`, `next/navigation`, the
// Supabase client and the cookie reader, so a unit test that needed the real
// module would have to mock four of them before asserting anything. Extracting
// the class makes the shared vocabulary importable on its own, and `queries.ts`
// re-exports it so nothing that imported it from there had to change.
const { IdentityRefusalError } = await import(
  "@/lib/supabase/identity-refusal"
);

const getCurrentPractitionerWithStudio = vi.fn();

// REPLACED WHOLESALE, not spread over the original: the point above is that
// loading the original is the expensive thing. `writing-identity` imports
// exactly this one function and one type from it.
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: () =>
    getCurrentPractitionerWithStudio() as unknown,
}));

const {
  resolveWritingIdentity,
  IDENTITY_REFUSED_NO_MEMBERSHIP,
  IDENTITY_REFUSED_CHOOSE_STUDIO,
  IDENTITY_NOT_SIGNED_IN,
} = await import("@/lib/supabase/writing-identity");

const {
  outcomeFromRecordResult,
  afterOutcome,
  afterDraftChanged,
  initialSaveState,
} = await import("@/lib/machines/save-attempt");

beforeEach(() => {
  getCurrentPractitionerWithStudio.mockReset();
});

const IDENTITY = {
  practitioner: { id: "prac-1", active: true },
  studio: { id: "studio-1" },
};

describe("a controlled identity refusal is REJECTED, not unknown", () => {
  it("a removed membership", () => {
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw new IdentityRefusalError(
        "no-active-practitioner",
        "No active practitioner found for the signed-in user.",
      );
    });
    return expect(resolveWritingIdentity()).resolves.toEqual({
      ok: false,
      code: "rejected",
      error: IDENTITY_REFUSED_NO_MEMBERSHIP,
    });
  });

  it("an invalid studio selection, with its OWN wording", () => {
    // The two refusals are not the same situation: one is actionable by her
    // (choose a studio) and one is not (ask the owner). One message for both
    // would tell half of them to do something impossible.
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw new IdentityRefusalError(
        "studio-choice-required",
        "Multiple active studio memberships (2) with no valid studio selection; choose a studio first.",
      );
    });
    return expect(resolveWritingIdentity()).resolves.toEqual({
      ok: false,
      code: "rejected",
      error: IDENTITY_REFUSED_CHOOSE_STUDIO,
    });
  });

  it("and BOTH messages say nothing was saved, which is the whole point", () => {
    for (const m of [
      IDENTITY_REFUSED_NO_MEMBERSHIP,
      IDENTITY_REFUSED_CHOOSE_STUDIO,
    ]) {
      expect(m, `"${m}" does not say nothing was saved`).toMatch(
        /[Nn]othing was saved/,
      );
    }
  });

  it("a FALSY identity is unauthenticated, not a crash", () => {
    // A REGRESSION FOUND BY `machine-setup-actions.test.ts`. The local
    // `identity()` wrapper this helper replaced read `if (!who) return null`,
    // which the action turned into `code: "unauthenticated"`. My first version
    // dereferenced `who.value.studio` instead and crashed. Production cannot
    // reach it — `getCurrentPractitionerWithStudio` redirects or throws first —
    // but the wrapper's contract allowed it and a test drives it, so the
    // branch is preserved rather than argued away.
    getCurrentPractitionerWithStudio.mockResolvedValue(null);
    return expect(resolveWritingIdentity()).resolves.toEqual({
      ok: false,
      code: "unauthenticated",
      error: IDENTITY_NOT_SIGNED_IN,
    });
  });

  it("and unauthenticated is NOT folded into rejected", () => {
    // The two are both definitive, and they are not the same thing: one says
    // sign in, the other says your access to this studio changed. A caller
    // that showed the wrong one would send her to fix something that is not
    // broken.
    expect(IDENTITY_NOT_SIGNED_IN).not.toBe(IDENTITY_REFUSED_NO_MEMBERSHIP);
  });

  it("passes identity through untouched when it resolves", () => {
    getCurrentPractitionerWithStudio.mockResolvedValue(IDENTITY);
    return expect(resolveWritingIdentity()).resolves.toEqual({
      ok: true,
      value: IDENTITY,
    });
  });
});

describe("and everything else is re-thrown UNCHANGED", () => {
  it("a Next redirect signal still propagates", async () => {
    // `getCurrentPractitionerWithStudio` sends an anonymous caller to /login
    // by throwing a routing signal. Swallowing it would turn a sign-in into a
    // silent refusal, so it must leave this helper untouched.
    const signal = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/login;307;",
    });
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw signal;
    });
    await expect(resolveWritingIdentity()).rejects.toBe(signal);
  });

  it("a notFound signal still propagates", async () => {
    const signal = Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), {
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw signal;
    });
    await expect(resolveWritingIdentity()).rejects.toBe(signal);
  });

  it("A GENUINE UNKNOWN still propagates, so the caller still holds the retry", async () => {
    // THE OPPOSITE ERROR, and the more expensive one. A fault raised once the
    // write is under way may have committed; reporting that as `rejected`
    // would unfreeze the draft and invite a second immutable record. Only the
    // ONE refusal type is converted.
    const fault = new Error("connection terminated unexpectedly");
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw fault;
    });
    await expect(resolveWritingIdentity()).rejects.toBe(fault);
  });

  it("and a LOOK-ALIKE is not honoured, because classification is by TYPE", async () => {
    // The two refusal sentences are ALSO raised by the database guard and are
    // listed in `lib/sessions/session-command-errors.ts`. Matching on text
    // would conflate a refusal from Postgres with one from this process, and
    // they differ on exactly the question that matters: whether a write was
    // attempted.
    const lookAlike = Object.assign(
      new Error("No active practitioner found for the signed-in user."),
      { kind: "no-active-practitioner" },
    );
    getCurrentPractitionerWithStudio.mockImplementation(() => {
      throw lookAlike;
    });
    await expect(resolveWritingIdentity()).rejects.toBe(lookAlike);
  });
});

describe("what the REVISION entry then does with it", () => {
  // THESE CASES ASSERTED THE DEFECT, and that is worth recording rather than
  // quietly rewriting (Codex, #860 4308887493).
  //
  // Round 6's fixture was `{ ..., recorded: true, unresolved: true }` and it
  // asserted that a definitive refusal CLEARED `unresolved`. Two things were
  // wrong with it:
  //
  //   1. THE STATE IS NOT REACHABLE. `recorded` only becomes true on a `saved`
  //      outcome, which also sets `unresolved: false` - so no run of the
  //      machine can be in `recorded && unresolved`. The test was asserting a
  //      transition out of a state that cannot exist.
  //   2. THE CLAIM WAS WRONG FROM AN UNRESOLVED STATE. A refusal proves THIS
  //      attempt wrote nothing; it cannot answer whether an EARLIER attempt
  //      committed. Clearing the flag re-enabled editing, `afterDraftChanged`
  //      dropped the retained key, and a later save appended a SECOND
  //      IMMUTABLE CAPTURE.
  //
  // The property round 6 meant to prove is true and is kept - from a SETTLED
  // state, which is where its reasoning applied. The unresolved case now
  // asserts the law instead. Both fixtures below are built by RUNNING the
  // machine, so neither can describe a state it cannot reach.

  /** Settled: a fresh draft, nothing outstanding. */
  const settled = initialSaveState();
  /** Unresolved: the first attempt's answer was lost, holding its key. */
  const lost = afterOutcome(settled, "key-1", { kind: "unknown" });

  it("FROM A SETTLED STATE a rejected result is definitive and unfreezes", () => {
    // Round 6's actual property, on the state it belongs to: nothing was
    // written, nothing was ambiguous beforehand, so holding the draft would be
    // the deadlock round 6 removed.
    const outcome = outcomeFromRecordResult(
      { ok: false, code: "rejected", error: IDENTITY_REFUSED_NO_MEMBERSHIP },
      1,
    );
    expect(outcome).toEqual({
      kind: "refused",
      error: IDENTITY_REFUSED_NO_MEMBERSHIP,
    });
    const next = afterOutcome(settled, "key-1", outcome);
    expect(
      next.unresolved,
      "a definitive refusal froze a draft that had nothing outstanding",
    ).toBe(false);
    expect(next.message).toBe(IDENTITY_REFUSED_NO_MEMBERSHIP);
    expect(next.key).toBe("key-1");
    expect(afterDraftChanged(next).key, "an edit could not drop a settled key").toBeNull();
  });

  it("FROM AN UNRESOLVED STATE the same result may NOT unfreeze", () => {
    // The correction. The refusal is still definitive about ITSELF, and says
    // nothing about the attempt whose answer was lost.
    expect(lost.unresolved).toBe(true);
    const next = afterOutcome(lost, "key-1", {
      kind: "refused",
      error: IDENTITY_REFUSED_NO_MEMBERSHIP,
    });
    expect(
      next.unresolved,
      "a refusal answered a question it cannot answer, so an edit can now drop the key",
    ).toBe(true);
    expect(next.key).toBe("key-1");
    expect(afterDraftChanged(next).key).toBe("key-1");
    // And she is still told WHY, which is what keeping the freeze must not cost.
    expect(next.message).toBe(IDENTITY_REFUSED_NO_MEMBERSHIP);
  });

  it("CONTROL: an UNKNOWN result still freezes, and still holds the key", () => {
    // Without this the fix reads as "never freeze", which would be the
    // opposite defect: a lost answer MUST hold the key, because the retry's
    // safety is that key.
    const outcome = outcomeFromRecordResult({ ok: false, code: "unknown" }, 1);
    expect(outcome).toEqual({ kind: "unknown" });
    const next = afterOutcome(lost, "key-1", outcome);
    expect(next.unresolved).toBe(true);
    expect(next.key).toBe("key-1");
    expect(
      afterDraftChanged(next).key,
      "an unresolved attempt's key was dropped by an edit",
    ).toBe("key-1");
  });
});

describe("and BOTH sites resolve identity through the one helper", () => {
  // WITHOUT THIS THE HELPER IS OPTIONAL. The previous pair of pre-write-refusal
  // fixes was written twice, once per site, and the second had to be found
  // separately — "a shared helper that callers may ignore is not one
  // definition, it is a fourth one waiting to be written".
  const read = (rel: string) =>
    readFileSync(nodePath.resolve(__dirname, "../../..", rel), "utf8")
      // LINE comments before BLOCK comments: both files discuss the defect by
      // name at length, and a guard reading raw text is tripped by the prose.
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

  const SITES = [
    "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts",
  ];

  it("each imports and calls resolveWritingIdentity", () => {
    for (const rel of SITES) {
      const code = read(rel);
      expect(code, `${rel} does not import the helper`).toMatch(
        /resolveWritingIdentity.*from "@\/lib\/supabase\/writing-identity"/s,
      );
      expect(code, `${rel} does not call the helper`).toMatch(
        /await resolveWritingIdentity\(\)/,
      );
    }
  });

  it("the INITIAL write reports unresolved: false on that path", () => {
    // The create form only freezes when the result carries `unresolved`, so
    // stating it explicitly is what makes the refusal definitive rather than
    // relying on a missing property.
    expect(read(SITES[0]!)).toMatch(
      /if \(!who\.ok\) \{\s*return \{ ok: false, error: who\.error, unresolved: false \};/,
    );
  });

  it("the REVISION write FORWARDS the helper's own code", () => {
    // NOT A HARDCODED "rejected", and this assertion used to demand one — which
    // is precisely what had to change to keep `unauthenticated` reaching the
    // caller. Forwarding is the claim: the helper classifies, the action
    // reports, and collapsing both codes to one here would be the quiet way to
    // make a failing test pass.
    expect(read(SITES[1]!)).toMatch(
      /if \(!who\.ok\) \{\s*return \{ ok: false, code: who\.code, error: who\.error \};/,
    );
  });

  it("ANTI-VACUITY: the stripped sources are still the actions", () => {
    for (const rel of SITES) {
      const code = read(rel);
      expect(code.length, `${rel} stripped to nothing`).toBeGreaterThan(10_000);
      expect(code).toMatch(/export async function/);
    }
  });
});

describe("and the THROW SITE still raises the typed refusal", () => {
  // WHY THIS EXISTS: a negative control reported NOT CAUGHT. Reverting
  // `queries.ts` to `throw new Error("No active practitioner found…")`
  // changed no test, because every case above MOCKS
  // `getCurrentPractitionerWithStudio` and throws the typed error itself. The
  // mock makes the production throw irrelevant — so the whole fix could be
  // undone at its source in silence.
  //
  // A SOURCE CONTRACT RATHER THAN A BEHAVIOURAL ONE, deliberately and with its
  // cost stated: running the real `getCurrentPractitionerWithStudio` needs
  // `react`'s server build, `next/navigation`, the Supabase client and the
  // cookie reader all mocked first (see
  // `tests/lib/supabase/request-identity-dedupe.test.ts`, which pays exactly
  // that price for a different property). This asserts the two branches
  // construct the typed error, which is the one thing the helper depends on.
  const stripped = readFileSync(
    nodePath.resolve(__dirname, "../../..", "lib/supabase/queries.ts"),
    "utf8",
  )
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  it("a removed membership throws IdentityRefusalError", () => {
    expect(stripped).toMatch(
      /throw new IdentityRefusalError\(\s*"no-active-practitioner",/,
    );
  });

  it("an invalid studio selection throws IdentityRefusalError", () => {
    expect(stripped).toMatch(
      /throw new IdentityRefusalError\(\s*"studio-choice-required",/,
    );
  });

  it("and NEITHER sentence is raised as a plain Error any more", () => {
    // The specific regression the limb performed. Either spelling would leave
    // the helper unable to classify, and the caller back to freezing.
    expect(
      stripped,
      "the no-membership refusal is an untyped Error again, so it cannot be classified",
    ).not.toMatch(/throw new Error\(\s*"No active practitioner/);
    expect(
      stripped,
      "the studio-choice refusal is an untyped Error again",
    ).not.toMatch(/throw new Error\(\s*[`"]Multiple active studio memberships/);
  });

  it("ANTI-VACUITY: the stripped source is still queries.ts", () => {
    expect(stripped).toMatch(
      /export async function getCurrentPractitionerWithStudio/,
    );
    expect(stripped.length).toBeGreaterThan(10_000);
  });
});
