import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { currentProse } from "./helpers/canonical-facts";

// NEW-CLIENT-MODE-01 cutover. THE DOCS TRUTH GUARD for the contradictions that the Willow
// cutover and the controlled step-G invitation exercise created in canonical prose.
//
// WHY THIS GUARD EXISTS. Every contradiction it covers was introduced by production
// moving, not by anyone writing something wrong. Each statement was accurate when
// written, no test asserted on it, and the suite stayed green while the documents handed
// an operator two mutually exclusive pictures. All of them were found by review rather
// than by CI.
//
// ── THE CLAIM CLASSES ────────────────────────────────────────────────────────────────
//
// 1 · ROLLBACK BY ENV EDIT — the dangerous one. Canonical sites told an operator that
//     clearing, emptying or removing a slug from NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS
//     returns a studio to the WAIT-01 email-only commit point, and that "clearing the env
//     var is the entire kill switch". For a CUT-OVER studio that is false:
//     `newClientWaitlistCommitIsDurable`
//     (lib/booking/new-client-waitlist-durability-bridge.ts) returns true at its cut-over
//     check BEFORE consulting that list, and the admission reader answers a stamped row
//     before the env bridge. An operator following those instructions would clear the
//     variable, believe a commit-point rollback had succeeded, and watch durable rows keep
//     being written. Rolling a cut-over studio back is a ROW WRITE through
//     `set_new_client_admission_mode`.
//
// 2 · DEPENDENCY / CURRENT-ROUTING — the same error stated the other way round: that which
//     path carries a studio's intake "now" DEPENDS ON allowlist membership, or is "not
//     derivable from persisted rows". For a cut-over studio the opposite is true — the path
//     is derivable from the row and does not depend on the list. One canonical sentence had
//     inverted the mechanism exactly, and a first pass at this guard did not look for the
//     dependency phrasing at all.
//
// 3 · "ZERO INVITATIONS HAVE EVER BEEN ISSUED" — real dated counts turned into standing
//     universals by the word "ever". One invitation was issued on 2026-10-02T00:14:55.792262Z.
//
// ── WHY THIS FILE IS STRUCTURED AS PURE DETECTORS OVER TEXT ──────────────────────────
//
// The first version of this guard was UNSOUND in three separate ways, each found by
// review after I had asserted it was sound. The structure below exists to make those
// three failures impossible rather than unlikely, and each is pinned by its own EXPLOIT
// CONTROL over synthetic text at the bottom of this file:
//
//   a) IT EXEMPTED BY PROXIMITY, NOT BY ASSOCIATION. It flattened the whole document and
//      accepted a qualifier anywhere in a 600-character window, so a false instruction
//      placed near a legitimate "legacy bridge" sentence — or near any withdrawal note —
//      was silently skipped. Qualifiers are now required IN THE SAME CLAIM as the match.
//
//   b) ITS POSITIVE ASSERTION WAS VACUOUS. It required `set_new_client_admission_mode` to
//      appear SOMEWHERE in the corpus, and that name appears throughout migration
//      inventories, grant tables and historical facts — so deleting every sentence that
//      actually tells an operator to use it for rollback would have left the test green.
//      It now requires the command and rollback/transition wording in ONE claim.
//
//   c) ITS MATCHER WAS BUILT FROM REMEMBERED PHRASINGS. It keyed on three literal
//      durable-allowlist spellings and missed both the kill-switch framing and the
//      dependency framing. It now keys on the ACTION and the MECHANISM CLAIM.
//
// ── WHAT STAYS WRITABLE, DELIBERATELY ───────────────────────────────────────────────
//
//   * the env list genuinely DOES govern a studio still on the legacy bridge, so a scoped
//     claim passes;
//   * a document must be free to quote what it supersedes, so a claim inside a withdrawal
//     passes — but only when the withdrawal is in that same claim;
//   * a DATED count or a dated measurement passes. Only the standing universal is banned;
//   * `canonical-facts:ignore` blocks are stripped first, as in every sibling guard.

// EVERY doc that can carry this instruction, not only the canonical prose five.
//
// The first corpus was the five production prose authorities, and review found the
// hazard still live in docs/10_DEPLOYMENT_AND_ENV.md — the runbook an operator actually
// opens to edit that very variable, and therefore the MOST likely place for a false
// kill-switch instruction to be acted on. A guard scoped to where the truth is recorded
// rather than to where instructions are read protects the wrong thing.
//
// Membership rule, so this list can be re-derived rather than remembered: every
// repository doc that names NEW_CLIENT_WAITLIST_STUDIO_SLUGS or
// NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS. `tests/docs/...corpus is complete` below
// pins that, so a new doc naming either variable fails until it is guarded or excluded
// on purpose.
const DOCS = [
  "production/current-state.md",
  "production/capability-register.md",
  "production/known-limitations.md",
  "production/migration-ledger.md",
  "production/new-client-admission-activation.md",
  "production/release-changelog.md",
  "production/releases/2026-08-19-willow-new-client-waitlist.md",
  "03_SECURITY_AND_PRIVACY.md",
  "10_DEPLOYMENT_AND_ENV.md",
] as const;

const ROOT = path.resolve(__dirname, "../../docs");

function read(name: string): string {
  return currentProse(readFileSync(path.join(ROOT, name), "utf8"));
}

/**
 * Split prose into CLAIMS — the unit a qualifier has to share with the thing it
 * qualifies.
 *
 * A claim ends at a sentence terminator, a markdown table-cell boundary (`|`), a list
 * marker, or a blank line. Table cells matter: these documents put whole arguments in one
 * row, and without `|` as a boundary a single row would be one claim and proximity would
 * sneak back in through the back door.
 */
export function splitClaims(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\s*\|\s*|\n\s*[-*]\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0);
}

// KEYED ON THE ASSERTION, NOT ON PHRASINGS. Enumerating spellings failed three times:
// it missed the kill-switch framing, then the dependency framing, then "clearing THIS
// variable" and "Unset or empty means". So an offending claim is now a CONJUNCTION — an
// env-edit verb AND a routing outcome in the same claim — which is what the false
// instruction actually IS, however it is worded.
const ENV_EDIT =
  /\b(?:clear(?:ing|s|ed)?|unset|empt(?:y|ied|ying)|remov(?:e|ing|ed)|delet(?:e|ing|ed)|drop(?:ping|ped)?)\b/i;

const ENV_SUBJECT =
  /\ballowlist\b|\bslug list\b|\bvariable\b|\benv var\b|NEW_CLIENT_WAITLIST_(?:DURABLE_)?STUDIO_SLUGS|\bthe (?:durable )?list\b|\bthe flag\b/i;

const ROUTING_OUTCOME =
  /WAIT-01|email[- ]only|email path|commit point|kill switch|notification email/i;

/** The kill-switch framing on its own already asserts the outcome. */
const KILL_SWITCH = /(?:entire|whole)\s+kill switch|kill switch is\b/i;

function assertsEnvControlsRouting(claim: string): boolean {
  if (KILL_SWITCH.test(claim)) return true;
  return ENV_EDIT.test(claim) && ENV_SUBJECT.test(claim) && ROUTING_OUTCOME.test(claim);
}

/**
 * Claims that a studio's ROUTING depends on list membership, or that its routing is not
 * derivable from rows.
 *
 * THE SUBJECT IS LOAD-BEARING, and leaving it out produced a false positive on a sentence
 * that is still correct. "present MEMBERSHIP is not derivable from persisted rows" is
 * true — you cannot read an env list off a row. What became false is "which PATH carries
 * intake now depends on allowlist membership / is not derivable from persisted rows",
 * because for a cut-over studio the path IS the row. So the dependency form only offends
 * when its subject is the route.
 */
const ROUTING_SUBJECT =
  /which (?:of the two )?(?:waitlist )?paths?|which path|\bthe path\b|\broute\b|carries (?:that|the|a) (?:intake|join)|commit point/i;

const DEPENDENCY_PHRASE =
  /depends? on (?:the |runtime )?(?:allowlist|slug list) membership|not derivable from persisted rows|membership(?:,| which)? (?:is )?re-read per request/i;

function assertsRoutingDependsOnList(claim: string): boolean {
  return ROUTING_SUBJECT.test(claim) && DEPENDENCY_PHRASE.test(claim);
}

/** The qualifier that makes either claim true again, required in the SAME claim. */
const SCOPED =
  /legacy[- ]bridge|still on the legacy bridge|not cut over|NOT CUT OVER|cannot (?:return|re-?route|move) a cut-over|cut-over check|no longer holds for a cut-over|unstamped/i;

/**
 * A claim that is explicitly historical, or explicitly withdrawing itself.
 *
 * NARROWED: a bare ISO date used to be enough, which meant a date on one clause exempted
 * a false instruction in another — "On 2026-10-02 one invitation was sent, but clearing
 * the allowlist returns Willow to WAIT-01" passed on the strength of the date alone. An
 * EXPLICIT historical form is now required, so dating a claim no longer licenses it.
 */
const EXEMPT_IN_CLAIM =
  /earlier revision|withdrawn|NO LONGER TRUE|NO LONGER HOLDS|previously (?:read|said|asserted)|superseded|at (?:every|the) measured instant|as of (?:that|the|this) reading|\bWAS\b named|had been (?:issued|named)|proven for the instants|dated (?:evidence|observation|reading)|that is a dated|earlier draft|at that time|then named|state observed/i;

const EVER_ISSUED =
  /(?:zero|no) invitations? (?:have|has) ever been issued|invitation has ever been issued/i;

/** Rollback / mode-transition guidance: the passage an operator would follow. */
const ROLLBACK_GUIDANCE =
  /roll(?:ing|ed|s)?\b[^.|]{0,60}\bback\b|rollback|roll(?:ing)?[- ]back|move .{0,40}\bmode\b|switch .{0,30}(?:mode|studio)|return(?:ing)? a cut-over studio|transition .{0,20}mode|cut a studio (?:back|over)/i;

const COMMAND = /set_new_client_admission_mode/;

// ── Detectors. Pure over text, so the exploit controls can drive them directly. ──

export function unscopedRollbackClaims(text: string): string[] {
  return splitClaims(text).filter(
    (c) =>
      (assertsEnvControlsRouting(c) || assertsRoutingDependsOnList(c)) &&
      !SCOPED.test(c) &&
      !EXEMPT_IN_CLAIM.test(c),
  );
}

export function universalInvitationClaims(text: string): string[] {
  return splitClaims(text).filter(
    (c) => EVER_ISSUED.test(c) && !EXEMPT_IN_CLAIM.test(c),
  );
}

/**
 * Claims that are ACTIVE rollback guidance AND name the command: the positive procedure.
 *
 * The withdrawal/negation filter is the point. Without it,
 * "An earlier revision said rolling Willow back uses set_new_client_admission_mode; that
 * is withdrawn." counted as guidance — so deleting the live procedure while leaving an
 * audit sentence behind would have kept this assertion green while operators had nothing
 * to follow.
 */
const NOT_ACTIVE_GUIDANCE =
  /earlier revision|withdrawn|NO LONGER TRUE|NO LONGER HOLDS|previously (?:read|said|asserted)|superseded|\bnot\b.{0,20}\bthrough set_new_client_admission_mode|never uses/i;

export function rollbackGuidanceNamingCommand(text: string): string[] {
  return splitClaims(text).filter(
    (c) => ROLLBACK_GUIDANCE.test(c) && COMMAND.test(c) && !NOT_ACTIVE_GUIDANCE.test(c),
  );
}

describe("NEW-CLIENT-MODE-01 — the cutover must not leave contradictory canonical prose", () => {
  it("no claim says an env-list edit controls a CUT-OVER studio's commit point or admission", () => {
    const offenders: string[] = [];
    for (const name of DOCS) {
      for (const c of unscopedRollbackClaims(read(name))) {
        offenders.push(`${name}: ${c.slice(0, 220)}`);
      }
    }
    expect(
      offenders,
      "A canonical claim says that editing NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS moves a " +
        "studio to the WAIT-01 email path, or that current routing depends on allowlist " +
        "membership, WITHOUT the scoping qualifier in that same claim. Since the first studio " +
        "was cut over, newClientWaitlistCommitIsDurable returns at its cut-over check before " +
        "reading that list, so the instruction is false for a cut-over studio and an operator " +
        "would believe a rollback succeeded when it had not. Scope the claim itself — a " +
        "qualifier in a neighbouring sentence does not count, and is exactly the hole the " +
        "first version of this guard had.",
    ).toEqual([]);
  });

  it("no claim asserts that zero invitations have EVER been issued at the pilot studio", () => {
    const offenders: string[] = [];
    for (const name of DOCS) {
      for (const c of universalInvitationClaims(read(name))) {
        offenders.push(`${name}: ${c.slice(0, 220)}`);
      }
    }
    expect(
      offenders,
      "A canonical claim states as a standing universal that no invitation has ever been " +
        "issued at the pilot studio. One was issued on 2026-10-02T00:14:55.792262Z during the " +
        "step-G acceptance exercise. Dated counts pass; 'ever' is a claim about all time that " +
        "production has already falsified.",
    ).toEqual([]);
  });

  it("the POSITIVE rollback procedure exists as guidance that names the command", () => {
    // Not "the command appears somewhere in the corpus" — that was vacuous, since the name
    // occurs in migration inventories, grant tables and historical facts, so deleting every
    // actual instruction would have left this green. The command and the rollback wording
    // must sit in ONE claim, which is what an operator would actually read and follow.
    const guidance = DOCS.flatMap((name) =>
      rollbackGuidanceNamingCommand(read(name)).map((c) => `${name}: ${c.slice(0, 200)}`),
    );
    expect(
      guidance.length,
      "No canonical claim combines rollback / mode-transition wording WITH " +
        "set_new_client_admission_mode. Removing the false env-edit rollback is only half the " +
        "repair: the real mechanism — a row write through the owner command — has to be stated " +
        "where an operator will read it, in the same breath as the rollback it replaces.",
    ).toBeGreaterThan(0);
  });
});

// ── EXPLOIT CONTROLS ────────────────────────────────────────────────────────────────
//
// One per failure mode the first version of this guard actually had. Each drives the
// detectors over synthetic text, so it cannot be satisfied by the real documents being
// correct today — and each would have PASSED (wrongly) under the old implementation.

describe("the detectors resist the three ways the first version was unsound", () => {
  it("a) a false claim near a legitimate scoped sentence is still caught", () => {
    // The old guard flattened the document and accepted any qualifier within 200 characters
    // before / 400 after, so this shape slipped through. The qualifier belongs to the FIRST
    // sentence; the second is an unqualified false instruction.
    const text =
      "An empty durable allowlist leaves every studio still on the legacy bridge on the " +
      "WAIT-01 email path. Clearing the allowlist re-routes Willow through WAIT-01 on the " +
      "very next request.";
    const caught = unscopedRollbackClaims(text);
    expect(caught, "a neighbouring qualifier must not exempt a different claim").toHaveLength(1);
    expect(caught[0]).toContain("re-routes Willow");
  });

  it("a') a false claim near an unrelated withdrawal note is still caught", () => {
    const text =
      "An earlier revision said the row sits in Waiting; that is withdrawn. " +
      "Clearing the env var is the entire kill switch.";
    const caught = unscopedRollbackClaims(text);
    expect(caught, "a nearby withdrawal must not exempt a different claim").toHaveLength(1);
    expect(caught[0]).toContain("kill switch");
  });

  it("b) the positive assertion is not satisfied by the command appearing in unrelated prose", () => {
    const inventoryOnly =
      "Migration 0204 creates set_new_client_admission_mode and revokes it from anon. " +
      "To roll a studio back, clear the durable allowlist.";
    expect(
      rollbackGuidanceNamingCommand(inventoryOnly),
      "a grant/inventory mention must not count as rollback guidance",
    ).toEqual([]);

    const realGuidance =
      "Rolling a cut-over studio back is a row write through set_new_client_admission_mode, " +
      "not an env edit.";
    expect(
      rollbackGuidanceNamingCommand(realGuidance),
      "guidance naming the command in the same claim must count",
    ).toHaveLength(1);
  });

  it("c) the dependency framing is caught, not only clear/remove/empty/kill-switch wording", () => {
    const dependency =
      "Which of the two waitlist paths carries that intake now depends on allowlist " +
      "membership, and is not derivable from persisted rows.";
    expect(
      unscopedRollbackClaims(dependency),
      "a dependency / not-row-derivable claim is the same error stated in reverse",
    ).not.toEqual([]);
  });

  it("d) a date on one clause does not exempt a false instruction in another", () => {
    // The old exemption accepted ANY ISO date anywhere in the claim, so this passed on
    // the strength of the date alone while carrying a false current instruction.
    const text =
      "On 2026-10-02 one invitation was sent, but clearing the allowlist returns Willow " +
      "to WAIT-01.";
    expect(
      unscopedRollbackClaims(text),
      "dating one clause must not license a false instruction in the same claim",
    ).not.toEqual([]);
  });

  it("e) a withdrawn audit sentence is not accepted as the live rollback procedure", () => {
    // Without this, deleting the real procedure and leaving the audit trail behind would
    // have kept the positive assertion green while operators had nothing to follow.
    const auditOnly =
      "An earlier revision said rolling Willow back uses set_new_client_admission_mode; " +
      "that is withdrawn.";
    expect(
      rollbackGuidanceNamingCommand(auditOnly),
      "a withdrawal is a record of guidance, not guidance",
    ).toEqual([]);
  });

  it("f) a correct membership-not-row-derivable claim is NOT flagged", () => {
    // The subject matters. You genuinely cannot read an env list off a row, so this
    // sentence is still true and must stay writable; the false form names the ROUTE.
    expect(
      unscopedRollbackClaims("Present membership is not derivable from persisted rows."),
      "a claim about reading CONFIGURATION from rows is still correct",
    ).toEqual([]);
    expect(
      unscopedRollbackClaims(
        "Which path carries that intake now is not derivable from persisted rows.",
      ),
      "a claim about reading the ROUTE from rows is what became false",
    ).not.toEqual([]);
  });

  it("and the scoped, dated and withdrawn forms all still pass", () => {
    const fine = [
      "An empty durable allowlist leaves every studio still on the legacy bridge on the WAIT-01 email path.",
      "Clearing the allowlist re-routes a studio that is not cut over to WAIT-01.",
      "An earlier revision said clearing the allowlist re-routes Willow; that is withdrawn.",
      "Zero invitations had been issued on that studio as of that reading.",
    ];
    for (const claim of fine) {
      expect(
        [...unscopedRollbackClaims(claim), ...universalInvitationClaims(claim)],
        `this form must stay writable: ${claim}`,
      ).toEqual([]);
    }
  });
});

describe("the guarded corpus is complete", () => {
  it("every repository doc naming either waitlist env var is in DOCS", () => {
    // The membership rule, enforced rather than remembered. The first version of this
    // guard covered the five production prose files and MISSED the deployment runbook —
    // the document an operator actually opens to edit the variable, and so the most
    // likely place for a false kill-switch instruction to be acted on. A guard scoped to
    // where truth is recorded rather than where instructions are read protects the wrong
    // thing. This test fails when a new doc names either variable, which forces a
    // decision instead of a silent gap.
    const VARS = /NEW_CLIENT_WAITLIST_(?:DURABLE_)?STUDIO_SLUGS/;
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".md") && VARS.test(readFileSync(p, "utf8"))) {
          found.push(path.relative(ROOT, p));
        }
      }
    };
    walk(ROOT);
    const guarded = new Set<string>(DOCS);
    expect(
      found.filter((f) => !guarded.has(f)),
      "a documentation file names NEW_CLIENT_WAITLIST_STUDIO_SLUGS or " +
        "NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS but is not in this guard's corpus, so it " +
        "can carry a false rollback instruction unchecked. Add it to DOCS, or exclude it " +
        "deliberately with a reason.",
    ).toEqual([]);
  });
});
