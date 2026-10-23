// Named check rows for 05B. Each row takes the subject `decide` and returns its violations, so the same rows run
// against the real export (expect none) and against unsafe mutants (expect some). Expected outcomes come only
// from oracle.ts / hand-table.ts (SPEC-05B, ARCH-01, the operator's directive).

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  ALL_DECISIONS,
  CLOSED_REASONS,
  CODEX,
  HUMAN,
  NOT_V1_REASONS,
  baseValue,
  candidate,
  ciValue,
  collected,
  deepClone,
  evidence,
  ext,
  fail,
  key,
  ok,
  openRows,
  oracle,
  review,
  rng,
  shuffled,
  thread,
} from "./oracle";
import { HAND_CASES } from "./hand-table";
import { fullTable, stratifiedTable, type TableEntry } from "./table";

export type Decide = (c: any, p?: any) => any;
export type Violation = { id: string; msg: string };
export type RowResult = { row: string; clause: string; checked: number; violations: Violation[] };

const MAX_KEEP = 25;
function rowResult(row: string, clause: string) {
  const r: RowResult & { add: (id: string, msg: string) => void } = {
    row,
    clause,
    checked: 0,
    violations: [],
    add(id: string, msg: string) {
      if (this.violations.length < MAX_KEEP) this.violations.push({ id, msg });
      else if (this.violations.length === MAX_KEEP) this.violations.push({ id: "…", msg: "(more violations elided)" });
      (this as any).total = ((this as any).total ?? 0) + 1;
    },
  };
  return r;
}

export function canon(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  return v === undefined ? "undefined" : JSON.stringify(v);
}

type Call = { threw: boolean; error?: any; out?: any };
export function call(decide: Decide, input: any, policy?: any, withPolicy = false): Call {
  try {
    return { threw: false, out: withPolicy ? decide(input, policy) : decide(input) };
  } catch (error) {
    return { threw: true, error };
  }
}
const label = (o: any) => (o?.decision === "UNKNOWN" ? `UNKNOWN(${o?.reasonCodes?.[0]})` : String(o?.decision));
const errText = (e: any) => {
  try {
    return String(e?.message ?? e).slice(0, 120);
  } catch {
    return "<unprintable error>";
  }
};

/** The full table (stride 1), or a stratified thinning of it for mutant runs. */
export function tableEntries(stride = 1): TableEntry[] {
  return [...(stride === 1 ? fullTable() : stratifiedTable(stride))];
}

// ---------------------------------------------------------------------------------------------------------------
// D-TABLE: every table input decides exactly what the oracle decides (decision, reasonCodes, blocking).

export function checkTable(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-TABLE", "SPEC-05B §2 table, §3 trust, every input of the product table");
  for (const e of entries) {
    r.checked += 1;
    const c = call(decide, e.input);
    const o = oracle(e.input);
    if (c.threw) {
      r.add(e.id, `threw ${errText(c.error)}; oracle ${label(o)}`);
      continue;
    }
    if (label(c.out) !== label(o)) r.add(e.id, `decided ${label(c.out)}; oracle ${label(o)} (row ${o.row})`);
    else if (canon(c.out.reasonCodes) !== canon(o.reasonCodes)) r.add(e.id, `reasonCodes ${canon(c.out.reasonCodes)}; oracle ${canon(o.reasonCodes)}`);
    else if (o.blocking !== undefined && canon(c.out.blocking) !== canon(o.blocking)) r.add(e.id, `blocking ${canon(c.out.blocking)}; oracle ${canon(o.blocking)}`);
  }
  return r;
}

// D-HAND: literal, hand-derived expectations.
export function checkHand(decide: Decide) {
  const r = rowResult("D-HAND", "hand-derived cases H01-H67 (SPEC-05B §1-§3, README rules 8-9; H56-H67 pass 2)");
  for (const h of HAND_CASES) {
    r.checked += 1;
    const c = call(decide, h.input());
    const want = h.decision === "UNKNOWN" ? `UNKNOWN(${h.reason})` : h.decision;
    if (c.threw) r.add(h.id, `threw ${errText(c.error)}; want ${want} [${h.clause}]`);
    else if (label(c.out) !== want) r.add(h.id, `decided ${label(c.out)}; want ${want} [${h.clause}]`);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-SHAPE / D-HMR / D-NEXT over a corpus of outputs.

const OUTPUT_KEYS = canon(["blocking", "decision", "humanMergeRequired", "nextAction", "reasonCodes"]);

export function corpus(entries: TableEntry[]): any[] {
  const inputs: any[] = entries.map((e) => e.input);
  for (const h of HAND_CASES) inputs.push(h.input());
  for (const r of CLOSED_REASONS) {
    inputs.push({ ok: false, reason: r, detail: `collection ${r}`, stage: "collect", diagnostics: {} });
    inputs.push(candidate({ reviews: fail(r, `reviews ${r}`) }));
    inputs.push(candidate({ ci: fail(r, `ci ${r}`) }));
  }
  inputs.push(...hostileInputs().map((h) => h.input));
  return inputs;
}

export function checkShape(decide: Decide, inputs: any[]) {
  const r = rowResult("D-SHAPE", "SPEC-05B §0 frozen output {decision, reasonCodes, blocking, nextAction, humanMergeRequired: true}");
  inputs.forEach((input, i) => {
    r.checked += 1;
    const c = call(decide, input);
    if (c.threw) return r.add(`#${i}`, `threw ${errText(c.error)}`);
    const o = c.out;
    if (!o || typeof o !== "object") return r.add(`#${i}`, `output is ${typeof o}`);
    if (canon(Object.keys(o).sort()) !== OUTPUT_KEYS) r.add(`#${i}`, `keys ${canon(Object.keys(o).sort())}`);
    if (!ALL_DECISIONS.includes(o.decision)) r.add(`#${i}`, `decision ${String(o.decision)} outside the 13`);
    if (!Array.isArray(o.reasonCodes) || o.reasonCodes.length !== 1 || typeof o.reasonCodes[0] !== "string") r.add(`#${i}`, `reasonCodes ${canon(o.reasonCodes)}`);
    else if (o.decision === "UNKNOWN" ? !CLOSED_REASONS.includes(o.reasonCodes[0]) : o.reasonCodes[0] !== o.decision) r.add(`#${i}`, `reasonCodes ${canon(o.reasonCodes)} for ${o.decision}`);
    if (typeof o.nextAction !== "string" || o.nextAction.length === 0 || o.nextAction.length > 400) r.add(`#${i}`, `nextAction ${String(o.nextAction).slice(0, 60)}`);
    try {
      JSON.stringify(o);
    } catch (e) {
      r.add(`#${i}`, `output not JSON-serializable: ${errText(e)}`);
    }
  });
  return r;
}

export function checkHumanMerge(decide: Decide, inputs: any[]) {
  const r = rowResult("D-HMR", "SPEC-05B §0 humanMergeRequired is always true; CANDIDATE is advisory");
  inputs.forEach((input, i) => {
    r.checked += 1;
    const c = call(decide, input);
    if (!c.threw && c.out?.humanMergeRequired !== true) r.add(`#${i}`, `humanMergeRequired ${String(c.out?.humanMergeRequired)} on ${label(c.out)}`);
  });
  return r;
}

export function checkNextFixed(decide: Decide, inputs: any[]) {
  const r = rowResult("D-NEXT", "SPEC-05B §0 nextAction is the fixed string for the decision, or for the UNKNOWN reason");
  const byKey = new Map<string, Set<string>>();
  for (const input of inputs) {
    const c = call(decide, input);
    if (c.threw || !c.out) continue;
    r.checked += 1;
    const k = label(c.out);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k)!.add(String(c.out.nextAction));
  }
  for (const [k, set] of byKey) if (set.size !== 1) r.add(k, `${set.size} different nextAction strings: ${[...set].map((s) => JSON.stringify(s.slice(0, 50))).join(" | ")}`);
  const all = new Set([...byKey.values()].flatMap((s) => [...s]));
  if (all.size > 12 + CLOSED_REASONS.length) r.add("closed", `${all.size} distinct nextAction strings exceeds the closed set`);
  return r;
}

/** Canary text in every GitHub-derived field must never reach nextAction (SPEC-05B §0). */
export function checkNextCanary(decide: Decide) {
  const r = rowResult("D-CANARY", "SPEC-05B §0 nothing GitHub says is ever copied into nextAction");
  const CANARY = "CANARYxyz";
  const inputs = [
    { ok: false, reason: "read_failed", detail: `${CANARY} detail`, stage: "collect", diagnostics: {} },
    candidate({ base: fail("base_ref", `${CANARY} base`) }),
    candidate({ ci: fail("shared_head", `${CANARY} ci`) }),
    candidate({ external: fail("unrecognized_context_state", `${CANARY} ext`) }),
    candidate({ reviews: fail("read_failed", `${CANARY} rev`) }),
    candidate({ external: ok({ external: [ext(`${CANARY}-fail`, "failure")] }) }),
    candidate({ external: ok({ external: [ext(`${CANARY}-pend`, "pending")] }) }),
    candidate({ ci: ok(ciValue("INCOMPLETE", { missingJob: `${CANARY} job` })) }),
    candidate({ ci: ok(ciValue("FAILED", { applicableRunIds: [424242] })) }),
    candidate({ ci: fail("wrong_base", `${CANARY} open-set`) }),
  ];
  inputs.forEach((input, i) => {
    r.checked += 1;
    const c = call(decide, input);
    if (c.threw) return r.add(`#${i}`, `threw ${errText(c.error)}`);
    if (String(c.out.nextAction).includes("CANARY") || String(c.out.nextAction).includes("424242")) r.add(`#${i}`, `nextAction copies GitHub text: ${c.out.nextAction}`);
  });
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// Precedence: pairs, row-scoped UNKNOWN, drift, CI_INCOMPLETE placement, unknown never reaches candidacy.

export const COND_ORDER = ["R1", "R2", "U3", "R3", "U4", "R4", "U5", "R5", "R6a", "R6b", "R7", "R8", "U9", "R9", "R10"];
const COND_DECISION: Record<string, string> = {
  R1: "NOT_OPEN",
  R2: "DRAFT_HOLD",
  U3: "UNKNOWN",
  R3: "NEEDS_REFRESH",
  U4: "UNKNOWN",
  R4: "CI_FAILED",
  U5: "UNKNOWN",
  R5: "EXTERNAL_BLOCKED",
  R6a: "CI_NOT_STARTED",
  R6b: "CI_INCOMPLETE",
  R7: "CI_PENDING",
  R8: "EXTERNAL_PENDING",
  U9: "UNKNOWN",
  R9: "REVIEW_MISSING",
  R10: "FINDINGS_OPEN",
};
const EXCLUSIVE = new Set(
  [
    ["U3", "R3"],
    ["U4", "R4"],
    ["U4", "R6a"],
    ["U4", "R6b"],
    ["U4", "R7"],
    ["R4", "R6a"],
    ["R4", "R6b"],
    ["R4", "R7"],
    ["R6a", "R6b"],
    ["R6a", "R7"],
    ["R6b", "R7"],
    ["U5", "R5"],
    ["U5", "R8"],
    ["U9", "R9"],
    ["U9", "R10"],
  ].map(([a, b]) => `${a}|${b}`),
);
export function compatiblePairs(): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < COND_ORDER.length; i += 1)
    for (let j = i + 1; j < COND_ORDER.length; j += 1) {
      const a = COND_ORDER[i], b = COND_ORDER[j];
      if (EXCLUSIVE.has(`${a}|${b}`)) continue;
      if (a === "R1" && b !== "R2") continue; // a terminal key has no rows (ARCH-01 §7, §24)
      pairs.push([a, b]);
    }
  return pairs;
}

/** D-PAIRS: for every compatible pair (a before b), some input has a as its FIRST holding condition and b also
 * holding; the subject must decide a's decision on every such input. Also proves coverage of all pairs. */
export function checkPairs(decide: Decide, entries: TableEntry[], requireCoverage = true) {
  const r = rowResult("D-PAIRS", "SPEC-05B §2 'the first row that holds is the decision', every precedence pair");
  const covered = new Map<string, number>();
  for (const e of entries) {
    const o = oracle(e.input);
    const holds = o.holds.filter((h) => COND_ORDER.includes(h));
    if (holds.length < 2) continue;
    const first = COND_ORDER.find((c) => holds.includes(c))!;
    const c = call(decide, e.input);
    for (const b of holds) {
      if (b === first) continue;
      const k = `${first}>${b}`;
      covered.set(k, (covered.get(k) ?? 0) + 1);
      r.checked += 1;
      const got = c.threw ? "THREW" : c.out.decision;
      if (got !== COND_DECISION[first]) r.add(e.id, `pair ${k}: decided ${c.threw ? "THREW" : label(c.out)}, want ${COND_DECISION[first]}`);
    }
  }
  if (requireCoverage) for (const [a, b] of compatiblePairs()) if (!covered.has(`${a}>${b}`)) r.add(`${a}>${b}`, "pair not covered by the table");
  (r as any).coverage = covered;
  return r;
}

/** D-ROWSCOPE: a failure decides only when reached (README rule 8): an earlier holding row wins, else UNKNOWN(reason). */
export function checkRowScope(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-ROWSCOPE", "SPEC-05B §2 / README rule 8: a row failure decides UNKNOWN only when the table reaches that row");
  for (const e of entries) {
    const o = oracle(e.input);
    const fails = o.holds.filter((h) => h.startsWith("U"));
    if (fails.length === 0) continue;
    r.checked += 1;
    const c = call(decide, e.input);
    if (c.threw) {
      r.add(e.id, `threw ${errText(c.error)}`);
      continue;
    }
    if (label(c.out) !== label(o)) r.add(e.id, `decided ${label(c.out)}; reached-row rule gives ${label(o)}`);
  }
  return r;
}

/** D-UNK: an UNKNOWN (any failing row, any collection failure) never reaches candidacy. */
export function checkUnknownNeverCandidate(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-UNK", "operator: any required uncertainty must exit before candidacy; README rule 8");
  for (const e of entries) {
    const o = oracle(e.input);
    if (!o.holds.some((h) => h.startsWith("U"))) continue;
    r.checked += 1;
    const c = call(decide, e.input);
    if (!c.threw && c.out.decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW") r.add(e.id, "a failing row reached CANDIDATE");
  }
  return r;
}

/** D-DRIFT: behind production is NEEDS_REFRESH before every CI rule (SPEC-05A A9, SPEC-05B row 3). */
export function checkDrift(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-DRIFT", "SPEC-05B row 3 before rows 4-11; SPEC-05A §7 A9");
  for (const e of entries) {
    if (e.dims.base !== "B3" || e.dims.draft !== "false") continue;
    r.checked += 1;
    const c = call(decide, e.input);
    if (c.threw || c.out.decision !== "NEEDS_REFRESH") r.add(e.id, `decided ${c.threw ? "THREW" : label(c.out)}, want NEEDS_REFRESH`);
  }
  return r;
}

/** D-CI6: CI_INCOMPLETE is decided exactly at row 6 (README rule 9). */
export function checkCi6(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-CI6", "SPEC-05B row 6, README rule 9: CI_INCOMPLETE after rows 1-5 and before rows 7-11");
  for (const e of entries) {
    if (e.dims.ci !== "INCOMPLETE") continue;
    r.checked += 1;
    const o = oracle(e.input);
    const c = call(decide, e.input);
    const got = c.threw ? "THREW" : label(c.out);
    if ((o.decision === "CI_INCOMPLETE") !== (got === "CI_INCOMPLETE") || got !== label(o)) r.add(e.id, `decided ${got}; row-6 placement gives ${label(o)}`);
  }
  return r;
}

/** D-TRUST: id AND type. Variants that match by id only, or by type only, establish nothing. */
export function checkTrustIdType(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-TRUST", "SPEC-05B §3 / ARCH-01 §20: numeric id AND type; null actor or null id matches nothing");
  const ID_ONLY = ["codexIdAsUser", "lowercaseBotType", "impostorCrPlusClean", "otherBot", "nullActor", "nullIdBot"];
  const THREAD_ID_ONLY = ["codexResolvedHumanIdBot", "impostorOpenerOpen", "nullIdOpenerOpen", "codexResolvedNull"];
  for (const e of entries) {
    const [rs, ts] = (e.dims.reviews ?? "").split("/");
    if (!ID_ONLY.includes(rs) && !THREAD_ID_ONLY.includes(ts)) continue;
    r.checked += 1;
    const o = oracle(e.input);
    const c = call(decide, e.input);
    if (c.threw || label(c.out) !== label(o)) r.add(e.id, `decided ${c.threw ? "THREW" : label(c.out)}; id-and-type trust gives ${label(o)}`);
  }
  return r;
}

/** D-VERDICT: verdict per channel. DISMISSED, PENDING, CLEAN on PR_REVIEW, COMMENTED on CLEAN_COMMENT establish nothing. */
export function checkVerdicts(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-VERDICT", "SPEC-05B §3 / ARCH-01 §17: accepted verdict per channel; qualifiesAtHead");
  const SETS = ["dismissedHead", "pendingHead", "cleanOnPrReview", "commentedOnClean", "crOnCleanChannel", "dismissedPlusClean", "cleanPlusCrOnCleanChannel", "commentedStale", "cleanStale", "crStale", "cleanPlusStaleCr"];
  for (const e of entries) {
    const [rs] = (e.dims.reviews ?? "").split("/");
    if (!SETS.includes(rs)) continue;
    r.checked += 1;
    const o = oracle(e.input);
    const c = call(decide, e.input);
    if (c.threw || label(c.out) !== label(o)) r.add(e.id, `decided ${c.threw ? "THREW" : label(c.out)}; verdict-per-channel gives ${label(o)}`);
  }
  return r;
}

/** D-FINDINGS: CHANGES_REQUESTED at head, and Codex-opened threads unresolved or resolved by a non-allowlisted resolver. */
export function checkFindings(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-FINDINGS", "SPEC-05B §3 FINDINGS_OPEN / ARCH-01 §18-§19");
  for (const e of entries) {
    const o = oracle(e.input);
    if (!o.holds.includes("R10") && !/cr|codex/i.test(e.dims.reviews ?? "")) continue;
    r.checked += 1;
    const c = call(decide, e.input);
    if (c.threw || label(c.out) !== label(o)) r.add(e.id, `decided ${c.threw ? "THREW" : label(c.out)}; FINDINGS_OPEN rule gives ${label(o)}`);
    else if (o.decision === "FINDINGS_OPEN" && canon(c.out.blocking) !== canon(o.blocking)) r.add(e.id, `blocking ${canon(c.out.blocking)}; want ${canon(o.blocking)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-REASONS: every closed reason passes through at every row and for a collection failure; every open-set reason
// (including prototype keys and coercible non-strings) becomes malformed.

export const OPEN_SET_REASONS: any[] = [
  ...NOT_V1_REASONS,
  "",
  "READ_FAILED",
  "unknown",
  " read_failed",
  "read_failed ",
  "read_failed\n",
  "toString",
  "__proto__",
  "constructor",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  null,
  undefined,
  0,
  1,
  true,
  ["read_failed"],
  { toString: () => "read_failed" },
  new String("read_failed"),
];

function rowFailureInput(row: string, reason: any, detail: any) {
  if (row === "collection") return { ok: false, reason, detail, stage: "collect", diagnostics: {} };
  return candidate({ [row]: { ok: false, reason, detail } });
}

export function checkReasons(decide: Decide) {
  const r = rowResult("D-REASONS", "SPEC-05B §0-§2: UNKNOWN(reason) for a closed reason, blocking {row, detail}; open-set → malformed");
  for (const row of ["collection", "base", "ci", "external", "reviews"]) {
    for (const reason of CLOSED_REASONS) {
      r.checked += 1;
      const c = call(decide, rowFailureInput(row, reason, `d-${row}-${reason}`));
      if (c.threw) r.add(`${row}/${reason}`, `threw ${errText(c.error)}`);
      else if (label(c.out) !== `UNKNOWN(${reason})`) r.add(`${row}/${reason}`, `decided ${label(c.out)}`);
      else if (canon(c.out.blocking) !== canon({ row, detail: `d-${row}-${reason}` })) r.add(`${row}/${reason}`, `blocking ${canon(c.out.blocking)}`);
    }
    OPEN_SET_REASONS.forEach((reason, i) => {
      r.checked += 1;
      const c = call(decide, rowFailureInput(row, reason, "x"));
      if (c.threw) r.add(`${row}/open#${i}`, `threw ${errText(c.error)}`);
      else if (c.out.decision !== "UNKNOWN" || c.out.reasonCodes?.[0] !== "malformed" || typeof c.out.reasonCodes?.[0] !== "string") {
        r.add(`${row}/open#${i}:${String(reason)}`, `decided ${label(c.out)} (reasonCodes ${canon(c.out.reasonCodes)})`);
      }
    });
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-PERM, D-DET, D-IRR, D-NOMUT

function permute(input: any, seed: number) {
  const x = deepClone(input);
  const r = rng(seed);
  const rows = x?.evidence?.rows;
  if (rows?.external?.ok) rows.external.value.external = shuffled(rows.external.value.external, r);
  if (rows?.reviews?.ok) {
    rows.reviews.value.reviews = shuffled(rows.reviews.value.reviews, r);
    rows.reviews.value.threads = shuffled(rows.reviews.value.threads, r);
  }
  return x;
}
const permutable = (input: any) => {
  const rows = input?.evidence?.rows;
  return (rows?.external?.ok && rows.external.value.external.length > 1) || (rows?.reviews?.ok && (rows.reviews.value.reviews.length > 1 || rows.reviews.value.threads.length > 1));
};

export function checkPermutation(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-PERM", "SPEC-05B §0 / ARCH-01 §26: the order of reviews, threads and external contexts never matters");
  for (const e of entries) {
    if (!permutable(e.input)) continue;
    const base = call(decide, e.input);
    for (const seed of [1, 2, 3]) {
      r.checked += 1;
      const c = call(decide, permute(e.input, seed));
      if (base.threw || c.threw || canon(c.out) !== canon(base.out)) r.add(`${e.id} seed=${seed}`, `${canon(base.out?.blocking)} → ${canon(c.out?.blocking)} (${label(base.out)} → ${label(c.out)})`);
    }
  }
  return r;
}

export function checkDeterminism(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-DET", "SPEC-05B §0 deterministic; no shared mutable state (operator)");
  const first = entries.map((e) => call(decide, e.input));
  const second = [...entries].reverse().map((e) => call(decide, deepClone(e.input))).reverse();
  entries.forEach((e, i) => {
    r.checked += 1;
    const a = first[i], b = second[i];
    if (a.threw !== b.threw || (!a.threw && canon(a.out) !== canon(b.out))) r.add(e.id, `${canon(a.out)} vs ${canon(b.out)}`);
  });
  return r;
}

type Perturb = { name: string; apply: (x: any) => boolean };
export const IRRELEVANT: Perturb[] = [
  { name: "observedAt", apply: (x) => ((x.evidence.observedAt = "1999-01-01T00:00:00Z"), true) },
  { name: "evidenceHash", apply: (x) => ((x.evidenceHash = "0".repeat(64)), true) },
  { name: "diagnostics", apply: (x) => ((x.diagnostics = { observedAt: "2000-01-01T00:00:00Z", attempts: 2, confirmed: true }), true) },
  { name: "key.prNumber/headRef/repo ids/baseRef", apply: (x) => (Object.assign(x.evidence.key, { prNumber: 1, headRef: "other", headRepoId: 7, baseRepoId: 8, baseRef: "other-ref" }), true) },
  {
    name: "base metadata",
    apply: (x) => {
      const b = x.evidence.rows?.base;
      if (!b?.ok) return false;
      Object.assign(b.value, { mergeBaseSha: "1".repeat(40), files: ["a", "b"], filesCapped: true, changedFiles: 99, createdAt: "2001-01-01T00:00:00Z", baseRefChanges: "too_many", associatedPrNumbers: [1, 2] });
      b.value.drift.aheadBy = 999;
      return true;
    },
  },
  {
    name: "review ids and thread outdated flags",
    apply: (x) => {
      const v = x.evidence.rows?.reviews;
      if (!v?.ok) return false;
      v.value.reviews.forEach((rv: any, i: number) => (rv.id = 1 + i * 0));
      v.value.threads.forEach((t: any) => (t.outdated = !t.outdated));
      return true;
    },
  },
  {
    name: "extra success contexts",
    apply: (x) => {
      const v = x.evidence.rows?.external;
      if (!v?.ok) return false;
      v.value.external.push(ext("zzz-success", "success"), ext("aaa-success", "success"));
      return true;
    },
  },
  {
    name: "untrusted reviews of every verdict and channel",
    apply: (x) => {
      const v = x.evidence.rows?.reviews;
      if (!v?.ok) return false;
      for (const ch of ["PR_REVIEW", "CLEAN_COMMENT"]) for (const vd of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING", "CLEAN"]) v.value.reviews.push(review(ch, { id: 4242, type: "Bot" }, vd, true), review(ch, { id: CODEX.id, type: "User" }, vd, true), review(ch, null, vd, true));
      return true;
    },
  },
  {
    name: "stale trusted reviews of every verdict and channel",
    apply: (x) => {
      const v = x.evidence.rows?.reviews;
      if (!v?.ok) return false;
      for (const ch of ["PR_REVIEW", "CLEAN_COMMENT"]) for (const vd of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING", "CLEAN"]) v.value.reviews.push(review(ch, CODEX, vd, false));
      return true;
    },
  },
  {
    name: "trusted at-head verdicts that establish nothing",
    apply: (x) => {
      const v = x.evidence.rows?.reviews;
      if (!v?.ok) return false;
      v.value.reviews.push(review("PR_REVIEW", CODEX, "DISMISSED", true), review("PR_REVIEW", CODEX, "PENDING", true), review("PR_REVIEW", CODEX, "CLEAN", true));
      for (const vd of ["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED", "PENDING"]) v.value.reviews.push(review("CLEAN_COMMENT", CODEX, vd, true));
      return true;
    },
  },
  {
    name: "threads opened by others, and Codex threads the human resolved",
    apply: (x) => {
      const v = x.evidence.rows?.reviews;
      if (!v?.ok) return false;
      for (const opener of [HUMAN, { id: CODEX.id, type: "User" }, null, { id: null, type: "Bot" }, { id: 4242, type: "Bot" }]) for (const res of [false, true]) v.value.threads.push(thread(opener, res, res ? CODEX : null));
      v.value.threads.push(thread(CODEX, true, HUMAN, true), thread(CODEX, true, HUMAN, false));
      return true;
    },
  },
];

export function checkIrrelevant(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-IRR", "ARCH-01 §26: irrelevant evidence cannot change the state (SPEC-05B §1 lists what 05B reads)");
  for (const e of entries) {
    if (e.input.evidence?.key?.state !== "OPEN") continue;
    const base = call(decide, e.input);
    for (const p of IRRELEVANT) {
      const x = deepClone(e.input);
      if (!p.apply(x)) continue;
      r.checked += 1;
      const c = call(decide, x);
      if (base.threw || c.threw || canon(c.out) !== canon(base.out)) r.add(`${e.id} +${p.name}`, `${label(base.out)} ${canon(base.out?.blocking)} → ${label(c.out)} ${canon(c.out?.blocking)}`);
    }
  }
  return r;
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as any)) deepFreeze((v as any)[k]);
  }
  return v;
}

export function checkNoMutation(decide: Decide, entries: TableEntry[]) {
  const r = rowResult("D-NOMUT", "SPEC-05B §0 pure: the input is never written");
  for (const e of entries) {
    r.checked += 1;
    const x = deepClone(e.input);
    const before = canon(x);
    const a = call(decide, x);
    if (canon(x) !== before) r.add(e.id, "input was mutated");
    const frozen = deepFreeze(deepClone(e.input));
    const b = call(decide, frozen);
    if (a.threw !== b.threw || canon(a.out) !== canon(b.out)) r.add(e.id, `frozen input decides differently: ${label(a.out)} vs ${label(b.out)}`);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-PURE: no file, shell, clock, randomness, environment or network access while deciding.

export function withTraps<T>(fn: () => T): { result?: T; error?: any; hits: string[] } {
  const hits: string[] = [];
  const restore: (() => void)[] = [];
  const patch = (obj: any, name: string, lbl: string) => {
    const orig = obj[name];
    if (typeof orig !== "function") return;
    obj[name] = function (this: any, ...a: any[]) {
      hits.push(lbl);
      return orig.apply(this, a);
    };
    restore.push(() => (obj[name] = orig));
  };
  for (const n of Object.keys(fs)) if (typeof (fs as any)[n] === "function" && /^[a-z]/.test(n) && !/^(constants)$/.test(n)) patch(fs, n, `fs.${n}`);
  for (const n of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) patch(cp, n, `child_process.${n}`);
  syncBuiltinESMExports();
  const RealDate = Date;
  const realNow = RealDate.now;
  RealDate.now = () => (hits.push("Date.now"), realNow());
  const DateTrap = new Proxy(RealDate, {
    construct(t, args) {
      if (args.length === 0) hits.push("new Date()");
      return Reflect.construct(t, args);
    },
    apply(t, th, args) {
      hits.push("Date()");
      return Reflect.apply(t, th, args);
    },
  });
  (globalThis as any).Date = DateTrap;
  const realRandom = Math.random;
  Math.random = () => (hits.push("Math.random"), realRandom());
  const realPerfNow = performance.now.bind(performance);
  (performance as any).now = () => (hits.push("performance.now"), realPerfNow());
  const realHr = process.hrtime;
  const hr: any = (...a: any[]) => (hits.push("process.hrtime"), (realHr as any)(...a));
  hr.bigint = () => (hits.push("process.hrtime.bigint"), realHr.bigint());
  (process as any).hrtime = hr;
  const realEnv = process.env;
  const envTrap = new Proxy(realEnv, {
    get: (t, k) => (typeof k === "string" && hits.push(`process.env.${k}`), Reflect.get(t, k)),
    has: (t, k) => (typeof k === "string" && hits.push(`process.env has ${k}`), Reflect.has(t, k)),
    ownKeys: (t) => (hits.push("process.env keys"), Reflect.ownKeys(t)),
  });
  let envPatched = false;
  try {
    (process as any).env = envTrap;
    envPatched = process.env === envTrap;
  } catch {
    envPatched = false;
  }
  const realFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = (...a: any[]) => (hits.push("fetch"), realFetch(...a));
  try {
    return { result: fn(), hits, ...(envPatched ? {} : { envTrapUnavailable: true }) } as any;
  } catch (error) {
    return { error, hits };
  } finally {
    (globalThis as any).fetch = realFetch;
    if (envPatched) (process as any).env = realEnv;
    (process as any).hrtime = realHr;
    (performance as any).now = realPerfNow;
    Math.random = realRandom;
    (globalThis as any).Date = RealDate;
    RealDate.now = realNow;
    for (const f of restore) f();
    syncBuiltinESMExports();
  }
}

export function checkPurity(decide: Decide, inputs: any[]) {
  const r = rowResult("D-PURE", "SPEC-05B §0 / operator: no GitHub, file, shell, clock, credential or environment access");
  const t = withTraps(() => {
    for (const input of inputs) {
      r.checked += 1;
      try {
        decide(input);
      } catch {
        /* totality is D-TOTAL's row */
      }
    }
  });
  const distinct = [...new Set(t.hits)];
  if (distinct.length > 0) r.add("traps", `accessed: ${distinct.slice(0, 12).join(", ")}`);
  if ((t as any).envTrapUnavailable) r.add("harness", "process.env trap could not be installed");
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-TOTAL: hostile inputs never throw, decide UNKNOWN(malformed), keep humanMergeRequired, serialize.

const throwAll = new Proxy(
  {},
  {
    get() {
      throw new Error("hostile get");
    },
    has() {
      throw new Error("hostile has");
    },
    ownKeys() {
      throw new Error("hostile ownKeys");
    },
    getOwnPropertyDescriptor() {
      throw new Error("hostile gopd");
    },
    getPrototypeOf() {
      throw new Error("hostile proto");
    },
  },
);
function revoked() {
  const p = Proxy.revocable({}, {});
  p.revoke();
  return p.proxy;
}
const throwingGetter = (obj: any, prop: string) => {
  Object.defineProperty(obj, prop, {
    get() {
      throw new Error(`hostile getter ${prop}`);
    },
    enumerable: true,
    configurable: true,
  });
  return obj;
};
/** Put a hostile value at a path inside a fresh CANDIDATE input. */
function atPath(path: string[], hostile: () => any) {
  const x = candidate();
  let o: any = x;
  for (const k of path.slice(0, -1)) o = o[k];
  o[path[path.length - 1]] = hostile();
  return x;
}
function getterAt(path: string[]) {
  const x = candidate();
  let o: any = x;
  for (const k of path.slice(0, -1)) o = o[k];
  throwingGetter(o, path[path.length - 1]);
  return x;
}

export function hostileInputs(): { name: string; input: any }[] {
  const out: { name: string; input: any }[] = [];
  const prims: [string, any][] = [
    ["undefined", undefined],
    ["null", null],
    ["0", 0],
    ["NaN", NaN],
    ["empty string", ""],
    ["string", "CANDIDATE_READY_FOR_HUMAN_REVIEW"],
    ["true", true],
    ["symbol", Symbol("x")],
    ["bigint", 10n],
    ["function", () => ({ ok: true })],
    ["array", []],
    ["array of candidate", [candidate()]],
    ["Map", new Map([["ok", true]])],
    ["Date", new Date(0)],
    ["throwing proxy", throwAll],
    ["revoked proxy", revoked()],
    ["{ok:true}", { ok: true }],
    ["{ok:'true'}", { ...candidate(), ok: "true" }],
    ["{ok:1}", { ...candidate(), ok: 1 }],
    ["evidence null", { ...candidate(), evidence: null }],
    ["evidence array", { ...candidate(), evidence: [] }],
    ["evidence string", { ...candidate(), evidence: "{}" }],
  ];
  for (const [n, v] of prims) out.push({ name: n, input: v });
  const paths = [
    ["evidence"],
    ["evidence", "key"],
    ["evidence", "terminal"],
    ["evidence", "rows"],
    ["evidence", "rows", "base"],
    ["evidence", "rows", "ci"],
    ["evidence", "rows", "external"],
    ["evidence", "rows", "reviews"],
    ["evidence", "rows", "reviews", "value"],
    ["evidence", "rows", "reviews", "value", "reviews"],
    ["evidence", "rows", "reviews", "value", "threads"],
    ["evidence", "rows", "ci", "value"],
    ["evidence", "rows", "base", "value", "drift"],
  ];
  for (const p of paths) {
    out.push({ name: `throwing proxy at ${p.join(".")}`, input: atPath(p, () => throwAll) });
    out.push({ name: `revoked proxy at ${p.join(".")}`, input: atPath(p, revoked) });
    out.push({ name: `throwing getter at ${p.join(".")}`, input: getterAt(p) });
  }
  for (const p of [["ok"], ["evidence", "key", "state"], ["evidence", "key", "isDraft"], ["evidence", "key", "headSha"], ["evidence", "rows", "ci", "value", "outcome"], ["evidence", "rows", "base", "value", "drift", "behindBy"]]) {
    out.push({ name: `throwing getter at ${p.join(".")}`, input: getterAt(p) });
  }
  {
    const x = candidate();
    const reviews = x.evidence.rows.reviews.value.reviews;
    throwingGetter(reviews[0], "actor");
    out.push({ name: "throwing getter at reviews[0].actor", input: x });
  }
  {
    const x = candidate();
    const arr = x.evidence.rows.reviews.value.reviews;
    x.evidence.rows.reviews.value.reviews = new Proxy(arr, {
      get(t, k) {
        if (k === "0") throw new Error("hostile index");
        return Reflect.get(t, k);
      },
    });
    out.push({ name: "array proxy throwing on index", input: x });
  }
  {
    const x = candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", CODEX, "CLEAN", true)], threads: [thread(CODEX, true, HUMAN)] }) });
    x.evidence.rows.reviews.value.threads[0].opener = throwAll;
    out.push({ name: "throwing proxy as thread opener", input: x });
  }
  {
    const x = candidate();
    (x.evidence.rows.reviews.value.reviews as any).length = 5; // sparse holes
    out.push({ name: "sparse reviews array", input: x });
  }
  {
    const x = candidate();
    x.evidence.rows.external.value.external = { length: 1, 0: ext("x", "failure") } as any;
    out.push({ name: "array-like external", input: x });
  }
  return out;
}

export function checkTotality(decide: Decide) {
  const r = rowResult("D-TOTAL", "SPEC-05B §0 total: nothing throws; input outside the contract → UNKNOWN(malformed)");
  for (const h of hostileInputs()) {
    r.checked += 1;
    const c = call(decide, h.input);
    if (c.threw) {
      r.add(h.name, `threw ${errText(c.error)}`);
      continue;
    }
    if (c.out?.decision !== "UNKNOWN" || c.out?.reasonCodes?.[0] !== "malformed") r.add(h.name, `decided ${label(c.out)}`);
    if (c.out?.humanMergeRequired !== true) r.add(h.name, "humanMergeRequired not true");
    try {
      JSON.stringify(c.out);
    } catch (e) {
      r.add(h.name, `output not serializable: ${errText(e)}`);
    }
  }
  // Cycles and huge or deep inputs: never throw, never hang (decision may be malformed or the normal one).
  const extra: { name: string; input: any }[] = [];
  {
    const x: any = candidate();
    x.evidence.rows.reviews.value.reviews[0].self = x.evidence.rows.reviews.value.reviews[0];
    x.self = x;
    extra.push({ name: "cyclic input", input: x });
  }
  {
    const x: any = candidate();
    let deep: any = {};
    const root = deep;
    for (let i = 0; i < 50000; i += 1) deep = deep.n = {};
    x.evidence.extra = root;
    extra.push({ name: "50k-deep irrelevant field", input: x });
  }
  {
    const many = [] as any[];
    for (let i = 0; i < 200000; i += 1) many.push(review("PR_REVIEW", { id: 1000 + (i % 7), type: "User" }, "COMMENTED", true));
    many.push(review("CLEAN_COMMENT", CODEX, "CLEAN", true));
    extra.push({ name: "200k reviews", input: candidate({ reviews: ok({ reviews: many, threads: [] }) }) });
  }
  for (const h of extra) {
    r.checked += 1;
    const t0 = Date.now();
    const c = call(decide, h.input);
    const ms = Date.now() - t0;
    if (c.threw) r.add(h.name, `threw ${errText(c.error)}`);
    else if (c.out?.humanMergeRequired !== true) r.add(h.name, "humanMergeRequired not true");
    if (ms > 5000) r.add(h.name, `took ${ms} ms`);
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-MAL: a wrong type, or a value outside the closed sets, in a field 05B reads, at a row the table reaches, decides
// UNKNOWN(malformed). The baseline is a CANDIDATE input, so every row is reached. Each mutation names the row that
// reads it (SPEC-05B §1, pass 2: "when the table reaches the row that reads it"): "evidence" (schema, key, terminal:
// read by row 1-2, always reached), "container" (the rows object itself: SPEC-SILENT which row reads it), or 3/4/5/9.

type Mut = { name: string; row: number | "evidence" | "container"; apply: (x: any) => void };
const setAt = (path: string[], v: any) => (x: any) => {
  let o = x;
  for (const k of path.slice(0, -1)) o = o[k];
  if (v === DELETE) delete o[path[path.length - 1]];
  else o[path[path.length - 1]] = typeof v === "function" && v.__fresh ? v() : v;
};
const DELETE = Symbol("delete");
const fresh = (f: () => any) => Object.assign(f, { __fresh: true });
const ROW_OF_RESULT: Record<string, number> = { base: 3, ci: 4, external: 5, reviews: 9 };
function rowOfPath(path: string[]): Mut["row"] {
  if (path[1] !== "rows") return "evidence";
  if (path.length === 2) return "container";
  return ROW_OF_RESULT[path[2]];
}
const show = (v: any) => String(v === DELETE ? "<deleted>" : typeof v === "function" ? "<fresh>" : v);

export function malformedReads(): Mut[] {
  const m: Mut[] = [];
  const add = (name: string, path: string[], v: any) => m.push({ name, row: rowOfPath(path), apply: setAt(path, v) });
  const K = ["evidence", "key"];
  for (const v of ["eng-loop-v1/evidence@2", "eng-loop-v1/evidence@1 ", "", null, 1, DELETE]) add(`schema=${show(v)}`, ["evidence", "schema"], v);
  for (const v of ["open", "Open", "DRAFT", "", 1, null, fresh(() => ["OPEN"]), fresh(() => new String("OPEN")), DELETE]) add(`key.state=${show(v)}`, [...K, "state"], v);
  for (const v of ["false", 0, null, DELETE]) add(`key.isDraft=${show(v)}`, [...K, "isDraft"], v);
  for (const v of [null, 123, DELETE]) add(`key.headSha=${show(v)}`, [...K, "headSha"], v);
  for (const v of ["false", 0, null, true, DELETE]) add(`terminal=${show(v)}`, ["evidence", "terminal"], v);
  add("rows=null", ["evidence", "rows"], null);
  add("rows=[]", ["evidence", "rows"], fresh(() => []));
  for (const row of ["base", "ci", "external", "reviews"]) {
    add(`${row}=null`, ["evidence", "rows", row], null);
    add(`${row} deleted`, ["evidence", "rows", row], DELETE);
    add(`${row}.ok='true'`, ["evidence", "rows", row, "ok"], "true");
    add(`${row}.ok=1`, ["evidence", "rows", row, "ok"], 1);
    add(`${row}.value=null`, ["evidence", "rows", row, "value"], null);
    add(`${row}.value deleted`, ["evidence", "rows", row, "value"], DELETE);
  }
  const D = ["evidence", "rows", "base", "value", "drift"];
  add("drift=null", D, null);
  add("drift deleted", D, DELETE);
  for (const v of [-1, 1.5, "0", null, NaN, Infinity, -Infinity, fresh(() => new Number(0)), DELETE, true, fresh(() => [0])]) add(`behindBy=${show(v)}`, [...D, "behindBy"], v);
  const O = ["evidence", "rows", "ci", "value", "outcome"];
  for (const v of ["succeeded", "SUCCESS", "success", "NO_FRONTIER", "completed", "SUCCEEDED ", "", null, 1, fresh(() => ["SUCCEEDED"]), fresh(() => new String("SUCCEEDED")), DELETE]) add(`ci.outcome=${show(v)}`, O, v);
  // Pass 2: applicableRunIds, when present, is a list of positive integers (null is SPEC-SILENT: a probe, not here).
  const RI = ["evidence", "rows", "ci", "value", "applicableRunIds"];
  for (const v of ["x", fresh(() => [0]), fresh(() => [-1]), fresh(() => [1.5]), fresh(() => ["1"]), fresh(() => [null]), fresh(() => ({})), fresh(() => [NaN]), fresh(() => [Infinity]), 7]) add(`applicableRunIds=${typeof v === "function" ? JSON.stringify((v as any)()) ?? "<fresh>" : show(v)}`, RI, v);
  const E = ["evidence", "rows", "external", "value", "external"];
  add("external=null", E, null);
  add("external={}", E, fresh(() => ({})));
  add("external='[]'", E, "[]");
  for (const st of ["SUCCESS", "Success", "error", "neutral", "skipped", "", null, 1, fresh(() => ["failure"]), fresh(() => new String("success")), DELETE]) {
    m.push({
      name: `external state=${show(st)}`,
      row: 5,
      apply: (x) => {
        const c: any = ext("vercel", "success");
        if (st === DELETE) delete c.state;
        else c.state = typeof st === "function" && (st as any).__fresh ? (st as any)() : st;
        x.evidence.rows.external.value.external = [ext("ok-ctx", "success"), c];
      },
    });
  }
  m.push({ name: "external element null", row: 5, apply: (x) => (x.evidence.rows.external.value.external = [null]) });
  m.push({ name: "external source number", row: 5, apply: (x) => (x.evidence.rows.external.value.external = [{ source: 7, state: "success" }]) });
  m.push({ name: "external source missing", row: 5, apply: (x) => (x.evidence.rows.external.value.external = [{ state: "success" }]) });
  const RV = ["evidence", "rows", "reviews", "value"];
  add("reviews list null", [...RV, "reviews"], null);
  add("reviews list object", [...RV, "reviews"], fresh(() => ({})));
  add("threads list null", [...RV, "threads"], null);
  add("threads deleted", [...RV, "threads"], DELETE);
  const badReviews: [string, any][] = [
    ["null review", null],
    ["qualifiesAtHead 'true'", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), qualifiesAtHead: "true" }],
    ["qualifiesAtHead 1", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), qualifiesAtHead: 1 }],
    ["qualifiesAtHead null", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), qualifiesAtHead: null }],
    ["qualifiesAtHead missing", (() => { const x: any = review("CLEAN_COMMENT", CODEX, "CLEAN", true); delete x.qualifiesAtHead; return x; })()],
    ["actor id string", review("CLEAN_COMMENT", { id: String(CODEX.id), type: "Bot" }, "CLEAN", true)],
    ["actor id float", review("CLEAN_COMMENT", { id: CODEX.id + 0.5, type: "Bot" }, "CLEAN", true)],
    ["actor type missing", review("CLEAN_COMMENT", { id: CODEX.id }, "CLEAN", true)],
    ["actor id missing", review("CLEAN_COMMENT", { type: "Bot" }, "CLEAN", true)],
    ["actor type number", review("CLEAN_COMMENT", { id: CODEX.id, type: 1 }, "CLEAN", true)],
    ["actor string", review("CLEAN_COMMENT", "chatgpt-codex-connector", "CLEAN", true)],
    ["actor number", review("CLEAN_COMMENT", CODEX.id, "CLEAN", true)],
    ["actor array", review("CLEAN_COMMENT", [CODEX.id, "Bot"], "CLEAN", true)],
    ["actor id NaN", review("CLEAN_COMMENT", { id: NaN, type: "Bot" }, "CLEAN", true)],
    ["channel number", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), channel: 1 }],
    ["channel null", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), channel: null }],
    ["verdict null", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), verdict: null }],
    ["verdict number", { ...review("CLEAN_COMMENT", CODEX, "CLEAN", true), verdict: 3 }],
    // Pass 2: channel and verdict are closed enums (ARCH-01 §24).
    ["channel REVIEW_THREAD", review("REVIEW_THREAD", CODEX, "CHANGES_REQUESTED", true)],
    ["channel pr_review", review("pr_review", CODEX, "COMMENTED", true)],
    ["channel 'PR_REVIEW '", review("PR_REVIEW ", CODEX, "COMMENTED", true)],
    ["channel ''", review("", CODEX, "CLEAN", true)],
    ["verdict changes_requested", review("PR_REVIEW", CODEX, "changes_requested", true)],
    ["verdict 'CHANGES_REQUESTED '", review("PR_REVIEW", CODEX, "CHANGES_REQUESTED ", true)],
    ["verdict APPROVE", review("PR_REVIEW", CODEX, "APPROVE", true)],
    ["verdict REACTION", review("CLEAN_COMMENT", CODEX, "REACTION", true)],
    ["verdict ''", review("PR_REVIEW", CODEX, "", true)],
    ["untrusted actor, verdict outside the enum", review("PR_REVIEW", { id: 4242, type: "User" }, "LGTM", false)],
  ];
  for (const [n, bad] of badReviews) {
    // Both before and after the valid trusted review, so lazy validation cannot skip it.
    m.push({ name: `review ${n} (first)`, row: 9, apply: (x) => (x.evidence.rows.reviews.value.reviews = [bad, review("CLEAN_COMMENT", CODEX, "CLEAN", true)]) });
    m.push({ name: `review ${n} (after a trusted one)`, row: 9, apply: (x) => (x.evidence.rows.reviews.value.reviews = [review("CLEAN_COMMENT", CODEX, "CLEAN", true), bad]) });
  }
  const badThreads: [string, any][] = [
    ["null thread", null],
    ["resolved 'true'", { ...thread(CODEX, true, HUMAN), resolved: "true" }],
    ["resolved 1", { ...thread(CODEX, true, HUMAN), resolved: 1 }],
    ["resolved missing", (() => { const t: any = thread(CODEX, true, HUMAN); delete t.resolved; return t; })()],
    ["opener id string", thread({ id: String(CODEX.id), type: "Bot" }, false, null)],
    ["opener string", thread("chatgpt-codex-connector", false, null)],
    ["resolver id string", thread(CODEX, true, { id: String(HUMAN.id), type: "User" })],
    ["resolver type missing", thread(CODEX, true, { id: HUMAN.id })],
    ["resolver string", thread(CODEX, true, "SaiSamyukthVemuri")],
  ];
  for (const [n, bad] of badThreads) {
    m.push({ name: `thread ${n}`, row: 9, apply: (x) => (x.evidence.rows.reviews.value.threads = [bad]) });
    m.push({ name: `thread ${n} (after a closed one)`, row: 9, apply: (x) => (x.evidence.rows.reviews.value.threads = [thread(CODEX, true, HUMAN), bad]) });
  }
  return m;
}

export function checkMalformedReads(decide: Decide) {
  const r = rowResult("D-MAL", "SPEC-05B §1 (pass 2): a wrong type, or a value outside the closed sets, anywhere 05B reads decides UNKNOWN(malformed)");
  for (const mut of malformedReads()) {
    r.checked += 1;
    const x = candidate();
    mut.apply(x);
    const c = call(decide, x);
    if (c.threw) r.add(mut.name, `threw ${errText(c.error)}`);
    else if (label(c.out) !== "UNKNOWN(malformed)") r.add(mut.name, `decided ${label(c.out)}`);
  }
  return r;
}

/** Conditions that decide at an earlier row than the mutated one. `reads` is the row result each one sets. */
const EARLIER: { name: string; row: number; reads: string; decision: string; apply: (x: any) => void }[] = [
  { name: "draft", row: 2, reads: "key", decision: "DRAFT_HOLD", apply: (x) => (x.evidence.key.isDraft = true) },
  { name: "behind 2", row: 3, reads: "base", decision: "NEEDS_REFRESH", apply: (x) => (x.evidence.rows.base = ok(baseValue(2))) },
  { name: "ci FAILED", row: 4, reads: "ci", decision: "CI_FAILED", apply: (x) => (x.evidence.rows.ci = ok(ciValue("FAILED"))) },
  { name: "external failure", row: 5, reads: "external", decision: "EXTERNAL_BLOCKED", apply: (x) => (x.evidence.rows.external = ok({ external: [ext("deploy", "failure")] })) },
  { name: "ci NO_RUN", row: 6, reads: "ci", decision: "CI_NOT_STARTED", apply: (x) => (x.evidence.rows.ci = ok(ciValue("NO_RUN"))) },
  { name: "ci INCOMPLETE", row: 6, reads: "ci", decision: "CI_INCOMPLETE", apply: (x) => (x.evidence.rows.ci = ok(ciValue("INCOMPLETE"))) },
  { name: "ci PENDING", row: 7, reads: "ci", decision: "CI_PENDING", apply: (x) => (x.evidence.rows.ci = ok(ciValue("PENDING"))) },
  { name: "external pending", row: 8, reads: "external", decision: "EXTERNAL_PENDING", apply: (x) => (x.evidence.rows.external = ok({ external: [ext("p", "pending")] })) },
];
const RESULT_OF_ROW: Record<number, string> = { 3: "base", 4: "ci", 5: "external", 9: "reviews" };

/** D-MAL-SCOPE (pass 2): malformed decides only when the table reaches the row that reads it, so an earlier row's
 * decision wins; evidence-level fields (schema, key, terminal) are read at rows 1-2 and always decide malformed. */
export function checkMalformedScope(decide: Decide) {
  const r = rowResult("D-MAL-SCOPE", "SPEC-05B §1 (pass 2): malformed 'when the table reaches the row that reads it (§2)'");
  for (const mut of malformedReads()) {
    if (mut.row === "container") continue; // SPEC-SILENT
    for (const cond of EARLIER) {
      if (mut.row === "evidence") {
        if (cond.row > 3) continue;
      } else if (!(cond.row < mut.row && cond.reads !== RESULT_OF_ROW[mut.row])) continue;
      r.checked += 1;
      const x = candidate();
      cond.apply(x);
      try {
        mut.apply(x);
      } catch {
        continue;
      }
      const want = mut.row === "evidence" ? "UNKNOWN(malformed)" : cond.decision;
      const c = call(decide, x);
      if (c.threw) r.add(`${cond.name} + ${mut.name}`, `threw ${errText(c.error)}`);
      else if (label(c.out) !== want) r.add(`${cond.name} + ${mut.name}`, `decided ${label(c.out)}, want ${want}`);
    }
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------
// D-POLICY: trust follows the policy argument, id AND type; a null id never matches; hostile policies never throw
// and never yield a candidate.

export function checkPolicy(decide: Decide) {
  const r = rowResult("D-POLICY", "SPEC-05B §0 policy argument (defaults to decision/policy.mjs), §3 id AND type");
  const P2 = { codex: [{ id: 5, type: "Bot" }], humanResolvers: [{ id: 6, type: "User" }] };
  const BOT5 = { id: 5, type: "Bot" };
  const cases: { name: string; input: any; policy: any; want: string }[] = [
    { name: "default codex untrusted under P2", input: candidate(), policy: P2, want: "REVIEW_MISSING" },
    { name: "P2 codex trusted", input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", BOT5, "CLEAN", true)], threads: [] }) }), policy: P2, want: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
    { name: "P2 codex as User untrusted", input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", { id: 5, type: "User" }, "CLEAN", true)], threads: [] }) }), policy: P2, want: "REVIEW_MISSING" },
    { name: "P2 resolver closes", input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", BOT5, "CLEAN", true)], threads: [thread(BOT5, true, { id: 6, type: "User" })] }) }), policy: P2, want: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
    { name: "default human does not close under P2", input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", BOT5, "CLEAN", true)], threads: [thread(BOT5, true, HUMAN)] }) }), policy: P2, want: "FINDINGS_OPEN" },
    { name: "default-codex thread ignored under P2", input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", BOT5, "CLEAN", true)], threads: [thread(CODEX, false, null)] }) }), policy: P2, want: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
    {
      name: "null-id policy entry never matches a null-id actor",
      input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", { id: null, type: "Bot" }, "CLEAN", true)], threads: [] }) }),
      policy: { codex: [{ id: null, type: "Bot" }], humanResolvers: [HUMAN] },
      want: "REVIEW_MISSING",
    },
    {
      name: "null-id resolver entry never matches a null-id resolver",
      input: candidate({ reviews: ok({ reviews: [review("CLEAN_COMMENT", CODEX, "CLEAN", true)], threads: [thread(CODEX, true, { id: null, type: "User" })] }) }),
      policy: { codex: [CODEX], humanResolvers: [{ id: null, type: "User" }] },
      want: "FINDINGS_OPEN",
    },
    { name: "explicit spec policy equals default (candidate)", input: candidate(), policy: { codex: [CODEX], humanResolvers: [HUMAN] }, want: "CANDIDATE_READY_FOR_HUMAN_REVIEW" },
  ];
  for (const k of cases) {
    r.checked += 1;
    const c = call(decide, k.input, k.policy, true);
    if (c.threw) r.add(k.name, `threw ${errText(c.error)}`);
    else if (label(c.out) !== k.want) r.add(k.name, `decided ${label(c.out)}, want ${k.want}`);
  }
  // Policies under which Codex trust cannot be established. (null and a policy without humanResolvers are
  // SPEC-SILENT — `?? default` or strict refusal — and are recorded by the probes, not asserted here.)
  for (const [n, bad] of [
    ["{}", {}],
    ["codex not a list", { codex: "x", humanResolvers: [HUMAN] }],
    ["no codex", { humanResolvers: [HUMAN] }],
    ["throwing proxy", throwAll],
    ["revoked proxy", revoked()],
    ["number", 42],
    ["string", "policy"],
    ["null entries", { codex: [null], humanResolvers: [null] }],
    ["codex id as string", { codex: [{ id: String(CODEX.id), type: "Bot" }], humanResolvers: [HUMAN] }],
  ] as [string, any][]) {
    r.checked += 1;
    const c = call(decide, candidate(), bad, true);
    if (c.threw) r.add(`hostile policy ${n}`, `threw ${errText(c.error)}`);
    else if (c.out.decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW") r.add(`hostile policy ${n}`, "decided CANDIDATE under a policy that trusts no actor");
    else if (c.out.humanMergeRequired !== true) r.add(`hostile policy ${n}`, "humanMergeRequired not true");
  }
  return r;
}

export const ALL_ROWS = [
  "D-TABLE",
  "D-HAND",
  "D-SHAPE",
  "D-HMR",
  "D-NEXT",
  "D-CANARY",
  "D-PAIRS",
  "D-ROWSCOPE",
  "D-UNK",
  "D-DRIFT",
  "D-CI6",
  "D-TRUST",
  "D-VERDICT",
  "D-FINDINGS",
  "D-REASONS",
  "D-PERM",
  "D-DET",
  "D-IRR",
  "D-NOMUT",
  "D-PURE",
  "D-TOTAL",
  "D-MAL",
  "D-MAL-SCOPE",
  "D-POLICY",
];

/** Run every row against a subject. `stride` thins the product table (mutant runs); the real subject uses 1. */
export function runAllDecideRows(decide: Decide, stride = 1): RowResult[] {
  const entries = tableEntries(stride);
  const sample = entries.filter((_, i) => i % 13 === 0);
  const inputs = corpus(sample);
  return [
    checkTable(decide, entries),
    checkHand(decide),
    checkShape(decide, inputs),
    checkHumanMerge(decide, inputs),
    checkNextFixed(decide, corpus(entries)),
    checkNextCanary(decide),
    checkPairs(decide, entries, stride === 1),
    checkRowScope(decide, entries),
    checkUnknownNeverCandidate(decide, entries),
    checkDrift(decide, entries),
    checkCi6(decide, entries),
    checkTrustIdType(decide, entries),
    checkVerdicts(decide, entries),
    checkFindings(decide, entries),
    checkReasons(decide),
    checkPermutation(decide, sample),
    checkDeterminism(decide, sample),
    checkIrrelevant(decide, sample),
    checkNoMutation(decide, sample),
    checkPurity(decide, inputs),
    checkTotality(decide),
    checkMalformedReads(decide),
    checkMalformedScope(decide),
    checkPolicy(decide),
  ];
}

export { baseValue, ciValue, collected, evidence, key, openRows, fail, ok };
