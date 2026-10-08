// The exhaustive evidence table: the product of every row's abstract outcomes (SPEC-05B §1-§3).
// Inputs are SPEC-05A-shaped; expected outcomes come from oracle.ts.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { CODEX, HUMAN, baseValue, ciValue, collected, evidence, ext, fail, key, ok, review, thread } from "./oracle";

export const FAIL_REASON = { base: "base_ref", ci: "base_history_unverified", external: "external_contexts_too_large", reviews: "review_evidence_too_large" };

export const BASE_VARIANTS: Record<string, () => any> = {
  F: () => fail(FAIL_REASON.base, "base: compare failed"),
  B0: () => ok(baseValue(0)),
  B3: () => ok(baseValue(3)),
};

export const CI_VARIANTS: Record<string, () => any> = {
  F: () => fail(FAIL_REASON.ci, "ci: production does not block force pushes"),
  SUCCEEDED: () => ok(ciValue("SUCCEEDED")),
  FAILED: () => ok(ciValue("FAILED")),
  PENDING: () => ok(ciValue("PENDING")),
  NO_RUN: () => ok(ciValue("NO_RUN")),
  INCOMPLETE: () => ok(ciValue("INCOMPLETE")),
};

export const EXT_VARIANTS: Record<string, () => any> = {
  F: () => fail(FAIL_REASON.external, "external: too many contexts"),
  none: () => ok({ external: [] }),
  s: () => ok({ external: [ext("vercel", "success")] }),
  p: () => ok({ external: [ext("zeta-pending", "pending"), ext("alpha-pending", "pending")] }),
  f: () => ok({ external: [ext("zeta-fail", "failure"), ext("alpha-fail", "failure")] }),
  pf: () => ok({ external: [ext("mid-pending", "pending"), ext("mid-fail", "failure")] }),
  spf: () => ok({ external: [ext("vercel", "success"), ext("q-pending", "pending"), ext("b-fail", "failure"), ext("a-fail", "failure")] }),
};

const C = CODEX;
const U = (id: number, type: string) => ({ id, type });

export const REVIEW_SETS: Record<string, () => any[]> = {
  none: () => [],
  cleanHead: () => [review("CLEAN_COMMENT", C, "CLEAN", true)],
  commentedHead: () => [review("PR_REVIEW", C, "COMMENTED", true)],
  approvedHead: () => [review("PR_REVIEW", C, "APPROVED", true)],
  crHead: () => [review("PR_REVIEW", C, "CHANGES_REQUESTED", true)],
  commentedStale: () => [review("PR_REVIEW", C, "COMMENTED", false)],
  cleanStale: () => [review("CLEAN_COMMENT", C, "CLEAN", false)],
  crStale: () => [review("PR_REVIEW", C, "CHANGES_REQUESTED", false)],
  dismissedHead: () => [review("PR_REVIEW", C, "DISMISSED", true)],
  pendingHead: () => [review("PR_REVIEW", C, "PENDING", true)],
  cleanOnPrReview: () => [review("PR_REVIEW", C, "CLEAN", true)],
  commentedOnClean: () => [review("CLEAN_COMMENT", C, "COMMENTED", true)],
  codexIdAsUser: () => [review("CLEAN_COMMENT", U(C.id, "User"), "CLEAN", true)],
  otherBot: () => [review("PR_REVIEW", U(12345, "Bot"), "COMMENTED", true)],
  nullActor: () => [review("CLEAN_COMMENT", null, "CLEAN", true)],
  nullIdBot: () => [review("CLEAN_COMMENT", { id: null, type: "Bot" }, "CLEAN", true)],
  humanApproved: () => [review("PR_REVIEW", HUMAN, "APPROVED", true)],
  impostorCrPlusClean: () => [review("PR_REVIEW", U(C.id, "User"), "CHANGES_REQUESTED", true), review("CLEAN_COMMENT", C, "CLEAN", true)],
  cleanPlusStaleCr: () => [review("CLEAN_COMMENT", C, "CLEAN", true), review("PR_REVIEW", C, "CHANGES_REQUESTED", false)],
  cleanPlusCr: () => [review("CLEAN_COMMENT", C, "CLEAN", true), review("PR_REVIEW", C, "CHANGES_REQUESTED", true)],
  crOnCleanChannel: () => [review("CLEAN_COMMENT", C, "CHANGES_REQUESTED", true)],
  cleanPlusCrOnCleanChannel: () => [review("CLEAN_COMMENT", C, "CLEAN", true), review("CLEAN_COMMENT", C, "CHANGES_REQUESTED", true)],
  dismissedPlusClean: () => [review("PR_REVIEW", C, "DISMISSED", true), review("CLEAN_COMMENT", C, "CLEAN", true)],
  lowercaseBotType: () => [review("PR_REVIEW", U(C.id, "bot"), "CHANGES_REQUESTED", true), review("PR_REVIEW", U(C.id, "bot"), "APPROVED", true)],
  approvedPlusUntrustedCr: () => [review("PR_REVIEW", C, "APPROVED", true), review("PR_REVIEW", U(777, "Bot"), "CHANGES_REQUESTED", true)],
};

export const THREAD_SETS: Record<string, () => any[]> = {
  none: () => [],
  codexOpen: () => [thread(C, false, null)],
  codexResolvedHuman: () => [thread(C, true, HUMAN)],
  codexResolvedCodex: () => [thread(C, true, C)],
  codexResolvedNull: () => [thread(C, true, null)],
  codexResolvedHumanIdBot: () => [thread(C, true, U(HUMAN.id, "Bot"))],
  codexResolvedOtherUser: () => [thread(C, true, U(999, "User"))],
  impostorOpenerOpen: () => [thread(U(C.id, "User"), false, null)],
  humanOpenerOpen: () => [thread(HUMAN, false, null)],
  nullOpenerOpen: () => [thread(null, false, null)],
  nullIdOpenerOpen: () => [thread({ id: null, type: "Bot" }, false, null)],
  codexUnresolvedHumanResolver: () => [thread(C, false, HUMAN)],
  resolvedOutdatedMix: () => [thread(C, true, HUMAN, true), thread(C, true, HUMAN, false)],
  codexOpenOutdated: () => [thread(C, false, null, true)],
  twoClosedOneOpen: () => [thread(C, true, HUMAN), thread(C, false, null, true), thread(C, true, HUMAN, true)],
};

export type TableEntry = { id: string; input: any; dims: Record<string, string> };

/**
 * The open-key product. `keep(comboIndex, reviewIndex)` thins it for mutant runs: comboIndex enumerates
 * (draft, base, ci, external) — 252 combinations — and reviewIndex the 376 review-row variants (0 is the failure).
 */
export function* openTable(keep: (combo: number, rv: number, dims: { draft: boolean; base: string; ci: string; external: string }) => boolean = () => true): Generator<TableEntry> {
  let combo = -1;
  for (const draft of [false, true]) {
    for (const [bk, b] of Object.entries(BASE_VARIANTS)) {
      for (const [ck, c] of Object.entries(CI_VARIANTS)) {
        for (const [ek, e] of Object.entries(EXT_VARIANTS)) {
          combo += 1;
          const reviewVariants: [string, () => any][] = [["F", () => fail(FAIL_REASON.reviews, "reviews: too large")]];
          for (const [rk, r] of Object.entries(REVIEW_SETS)) {
            for (const [tk, t] of Object.entries(THREAD_SETS)) reviewVariants.push([`${rk}/${tk}`, () => ok({ reviews: r(), threads: t() })]);
          }
          for (let ri = 0; ri < reviewVariants.length; ri += 1) {
            if (!keep(combo, ri, { draft, base: bk, ci: ck, external: ek })) continue;
            const [vk, v] = reviewVariants[ri];
            const dims = { draft: String(draft), base: bk, ci: ck, external: ek, reviews: vk };
            yield {
              id: `d=${draft} b=${bk} c=${ck} e=${ek} r=${vk}`,
              input: collected(evidence(key("OPEN", draft), { base: b(), ci: c(), external: e(), reviews: v() })),
              dims,
            };
          }
        }
      }
    }
  }
}

export function terminalTable(): TableEntry[] {
  const out: TableEntry[] = [];
  for (const state of ["CLOSED", "MERGED"]) for (const draft of [false, true]) out.push({ id: `terminal ${state} draft=${draft}`, input: collected(evidence(key(state, draft), null)), dims: { state, draft: String(draft) } });
  return out;
}

export function* fullTable(): Generator<TableEntry> {
  yield* terminalTable();
  yield* openTable();
}

/** Stratified thinning for mutant runs: every (draft, base, ci, external) combination keeps its review-row failure
 * and a rotating 1/stride of the review variants; the combinations where rows 1-8 all pass (where the review rules
 * decide) keep every review and thread variant. */
export function* stratifiedTable(stride: number): Generator<TableEntry> {
  yield* terminalTable();
  yield* openTable((combo, rv, d) => rv === 0 || (rv + combo * 7) % stride === 0 || (!d.draft && d.base === "B0" && d.ci === "SUCCEEDED" && (d.external === "none" || d.external === "s")));
}
