import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { currentProse } from "./helpers/canonical-facts";

// NEW-CLIENT-MODE-01 cutover. THE DOCS TRUTH GUARD for two contradictions that the
// Willow cutover and the controlled step-G invitation exercise created, and that the
// canonical prose carried for a while without noticing.
//
// WHY THIS GUARD EXISTS. Both contradictions were introduced by production moving, not
// by anyone writing something wrong. Both were therefore invisible to every existing
// guard: the statements were accurate when written, no test asserted on them, and the
// suite stayed green while the documents gave an operator two mutually exclusive
// pictures. They were each found by review rather than by CI, one of them only after
// four earlier rounds had corrected neighbouring sentences in the same files.
//
// CLASS 1 — THE ROLLBACK PROCEDURE THAT NO LONGER WORKS, AND IS THE DANGEROUS ONE.
// Four canonical sites told an operator that clearing or emptying
// `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` returns a studio — Willow specifically, or
// "every studio" — to the WAIT-01 email-only commit point. Since Willow was stamped
// persisted WAITLIST on 2026-10-01, that is false for it, because
// `newClientWaitlistCommitIsDurable` in
// `lib/booking/new-client-waitlist-durability-bridge.ts` answers the cut-over check and
// returns true BEFORE it consults that env list. An operator following those
// instructions would clear the variable, believe a commit-point rollback had succeeded,
// and Willow would carry on writing durable rows. Rolling a cut-over studio back is a
// ROW WRITE through `set_new_client_admission_mode`, never an env edit.
//
// CLASS 2 — "ZERO INVITATIONS HAVE EVER BEEN ISSUED". Four sites said no invitation had
// ever been issued at Willow, and two of them built a further claim on it ("every later
// stage is untouched"). One invitation WAS issued on 2026-10-02T00:14:55.792262Z during
// the step-G acceptance exercise. The counts were real readings; the word "ever" turned
// each into a standing universal that production then falsified.
//
// HOW THIS GUARD AVOIDS OVERCORRECTING. Both phrasings have legitimate uses that must
// stay writable:
//   * the env list genuinely DOES govern a studio still on the legacy bridge, so the
//     claim is correct whenever it is SCOPED — "legacy-bridge studio", "not cut over",
//     "still on the legacy bridge", or an explicit "cannot re-route a cut-over studio";
//   * a document must be free to quote what it supersedes, so a match inside a
//     withdrawal ("an earlier revision said…", "withdrawn", "NO LONGER TRUE") passes;
//   * `canonical-facts:ignore` blocks are removed first, same as every sibling guard,
//     because those exist to quote superseded text verbatim;
//   * a DATED invitation count is fine. Only the unscoped universal is banned, so
//     "zero invitations had been issued as of that reading" passes and "zero
//     invitations have ever been issued" does not.
//
// The guard therefore asserts a SHAPE, not a vocabulary: every occurrence of either
// claim must carry its qualifier within the same sentence-ish window.

const DOCS = [
  "current-state.md",
  "capability-register.md",
  "known-limitations.md",
  "migration-ledger.md",
  "new-client-admission-activation.md",
] as const;

const ROOT = path.resolve(__dirname, "../../docs/production");

function read(name: string): string {
  return currentProse(readFileSync(path.join(ROOT, name), "utf8"));
}

/** Collapse to one line so a qualifier that wrapped still counts as nearby. */
function flat(doc: string): string {
  return doc.replace(/\s+/g, " ");
}

/** A window around each match, wide enough to contain a wrapped qualifier. */
function windows(text: string, patterns: readonly RegExp[]): string[] {
  const out: string[] = [];
  for (const re of patterns) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags + (re.flags.includes("g") ? "" : "g")))) {
      const i = m.index ?? 0;
      out.push(text.slice(Math.max(0, i - 200), i + 400));
    }
  }
  return out;
}

const WITHDRAWN =
  /earlier revision|withdrawn|NO LONGER TRUE|previously (read|said)|superseded/i;

// ── Class 1 ────────────────────────────────────────────────────────────────────
const ROLLBACK_CLAIMS: readonly RegExp[] = [
  /clearing the (?:durable )?(?:allowlist|variable|list)/gi,
  /empt(?:y|ying) (?:the )?durable allowlist/gi,
  /An empty durable allowlist/gi,
];

const CUTOVER_SCOPED =
  /legacy[- ]bridge|still on the legacy bridge|not cut over|NOT CUT OVER|cannot (?:return|re-?route) a cut-over|cut-over check/i;

// ── Class 2 ────────────────────────────────────────────────────────────────────
const EVER_ISSUED: readonly RegExp[] = [
  /(?:zero|no) invitations? (?:have|has) ever been issued/gi,
  /invitation has ever been issued/gi,
];

describe("NEW-CLIENT-MODE-01 — the cutover must not leave contradictory canonical prose", () => {
  it("never claims an env-list edit can move a CUT-OVER studio off the durable commit point", () => {
    const unscoped: string[] = [];
    for (const name of DOCS) {
      const text = flat(read(name));
      for (const w of windows(text, ROLLBACK_CLAIMS)) {
        if (CUTOVER_SCOPED.test(w)) continue;
        if (WITHDRAWN.test(w)) continue;
        unscoped.push(`${name}: …${w.slice(150, 400)}…`);
      }
    }
    expect(
      unscoped,
      "A canonical document says clearing or emptying NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS " +
        "moves a studio to the WAIT-01 email path, without scoping that to a studio still on the " +
        "legacy bridge. Since the first studio was cut over, newClientWaitlistCommitIsDurable " +
        "returns true at its cut-over check BEFORE reading that list, so the instruction is false " +
        "for a cut-over studio and an operator would believe a rollback succeeded when it had not. " +
        "Scope it, or state that it cannot re-route a cut-over studio.",
    ).toEqual([]);
  });

  it("never asserts that zero invitations have EVER been issued at the pilot studio", () => {
    const universal: string[] = [];
    for (const name of DOCS) {
      const text = flat(read(name));
      for (const w of windows(text, EVER_ISSUED)) {
        if (WITHDRAWN.test(w)) continue;
        universal.push(`${name}: …${w.slice(150, 400)}…`);
      }
    }
    expect(
      universal,
      "A canonical document states as a standing universal that no invitation has ever been " +
        "issued at the pilot studio. One was issued on 2026-10-02T00:14:55.792262Z during the " +
        "step-G acceptance exercise. Dated counts are fine — say 'had been issued as of that " +
        "reading' — but 'ever' is a claim about all time that production has already falsified.",
    ).toEqual([]);
  });

  it("states the cut-over rollback mechanism positively, so the scoping is not only a negation", () => {
    // A guard that only bans the false sentence can be satisfied by deleting it, which
    // would leave an operator with no rollback procedure at all. Require the real one
    // to be written down somewhere in the canonical set.
    const all = DOCS.map(read).join("\n");
    expect(
      /set_new_client_admission_mode/.test(all),
      "No canonical document names set_new_client_admission_mode as the way to move a cut-over " +
        "studio's mode. Removing the false env-edit rollback is only half the repair; the real " +
        "mechanism — a row write through the owner command — has to be stated.",
    ).toBe(true);
  });
});
