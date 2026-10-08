// Unsafe 05B mutants, built by wrapping the real `decide` export (its source is never read). Each simulates one
// class of defect; the mutation test shows that at least one named row catches it.

/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from "node:fs";
import { CODEX, HUMAN, CLOSED_REASONS, CHANNELS, ALL_VERDICTS, CI_OUTCOMES, EXTERNAL_STATES, review, deepClone } from "./oracle";

type Decide = (c: any, p?: any) => any;

const isPlain = (v: any) => v !== null && typeof v === "object";
function tryClone(c: any): any {
  try {
    return deepClone(c);
  } catch {
    return undefined;
  }
}
const rowsOf = (x: any) => (isPlain(x) && x.ok === true && isPlain(x.evidence) && isPlain(x.evidence.rows) ? x.evidence.rows : null);
const okRow = (r: any) => isPlain(r) && r.ok === true && isPlain(r.value);
const failRow = (r: any) => isPlain(r) && r.ok === false;
const POL_TYPES = new Map<number, string>([[CODEX.id, CODEX.type], [HUMAN.id, HUMAN.type]]);

/** Rewrite the input (on a JSON clone) and hand it to the real decide. */
const rewrite = (real: Decide, f: (x: any) => void): Decide => (c, p) => {
  const x = tryClone(c);
  if (x === undefined) return p === undefined ? real(c) : real(c, p);
  try {
    f(x);
  } catch {
    /* leave as is */
  }
  return p === undefined ? real(x) : real(x, p);
};

export function decideMutants(real: Decide): Record<string, Decide> {
  const call = (x: any, p: any) => (p === undefined ? real(x) : real(x, p));
  let counter = 0;
  const memo = new Map<string, any>();
  return {
    "M01 drift checked after CI (rows 3/4 swapped)": (c, p) => {
      const rows = rowsOf(c);
      if (rows && okRow(rows.base) && rows.base.value.drift?.behindBy > 0 && c.evidence.key?.isDraft === false) {
        const x = deepClone(c);
        x.evidence.rows.base.value.drift.behindBy = 0;
        const d = call(x, p);
        if (d.decision === "CI_FAILED" || (d.decision === "UNKNOWN" && d.blocking?.row === "ci")) return d;
      }
      return call(c, p);
    },
    "M02 trust by numeric id only": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (!rows || !okRow(rows.reviews)) return;
      const fix = (a: any) => (isPlain(a) && POL_TYPES.has(a.id) ? { ...a, type: POL_TYPES.get(a.id) } : a);
      for (const r of rows.reviews.value.reviews ?? []) if (isPlain(r)) r.actor = fix(r.actor);
      for (const t of rows.reviews.value.threads ?? []) if (isPlain(t)) {
        t.opener = fix(t.opener);
        t.resolver = fix(t.resolver);
      }
    }),
    "M03 DISMISSED accepted as a review": rewrite(real, (x) => {
      for (const r of rowsOf(x)?.reviews?.value?.reviews ?? []) if (r?.verdict === "DISMISSED") r.verdict = "COMMENTED";
    }),
    "M04 PENDING accepted as a review": rewrite(real, (x) => {
      for (const r of rowsOf(x)?.reviews?.value?.reviews ?? []) if (r?.verdict === "PENDING") r.verdict = "COMMENTED";
    }),
    "M05 skipped UNKNOWN row: external failure read as no contexts": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && failRow(rows.external)) rows.external = { ok: true, value: { external: [] } };
    }),
    "M06 skipped UNKNOWN row: reviews failure read as a clean review": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && failRow(rows.reviews)) rows.reviews = { ok: true, value: { reviews: [review("CLEAN_COMMENT", CODEX, "CLEAN", true)], threads: [] } };
    }),
    "M07 skipped UNKNOWN row: ci failure read as SUCCEEDED": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && failRow(rows.ci)) rows.ci = { ok: true, value: { outcome: "SUCCEEDED", applicableRunIds: [1] } };
    }),
    "M08 skipped UNKNOWN row: base failure read as up to date": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && failRow(rows.base)) rows.base = { ok: true, value: { drift: { behindBy: 0, aheadBy: 0 } } };
    }),
    "M09 CI_INCOMPLETE decided before row 3": (c, p) => {
      const rows = rowsOf(c);
      if (rows && okRow(rows.ci) && rows.ci.value.outcome === "INCOMPLETE" && c.evidence.key?.isDraft === false) {
        const d = call(c, p);
        if (d.decision !== "NOT_OPEN" && d.decision !== "DRAFT_HOLD") return { ...d, decision: "CI_INCOMPLETE", reasonCodes: ["CI_INCOMPLETE"], blocking: { runIds: rows.ci.value.applicableRunIds, missingJob: rows.ci.value.missingJob } };
      }
      return call(c, p);
    },
    "M10 CI_INCOMPLETE decided after row 10": (c, p) => {
      const rows = rowsOf(c);
      if (rows && okRow(rows.ci) && rows.ci.value.outcome === "INCOMPLETE") {
        const x = deepClone(c);
        x.evidence.rows.ci.value.outcome = "SUCCEEDED";
        const d = call(x, p);
        if (d.decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW") return call(c, p);
        return d;
      }
      return call(c, p);
    },
    "M11 qualifiesAtHead ignored (stale reviews count)": rewrite(real, (x) => {
      for (const r of rowsOf(x)?.reviews?.value?.reviews ?? []) if (isPlain(r) && r.qualifiesAtHead === false) r.qualifiesAtHead = true;
    }),
    "M12 any resolved thread is closed (resolver allowlist ignored)": rewrite(real, (x) => {
      for (const t of rowsOf(x)?.reviews?.value?.threads ?? []) if (isPlain(t) && t.resolved === true) t.resolver = { ...HUMAN };
    }),
    "M13 outdated threads ignored": rewrite(real, (x) => {
      const v = rowsOf(x)?.reviews?.value;
      if (v && Array.isArray(v.threads)) v.threads = v.threads.filter((t: any) => !(isPlain(t) && t.outdated === true));
    }),
    "M14 CHANGES_REQUESTED does not force FINDINGS_OPEN": rewrite(real, (x) => {
      for (const r of rowsOf(x)?.reviews?.value?.reviews ?? []) if (r?.verdict === "CHANGES_REQUESTED" && r?.channel === "PR_REVIEW") r.verdict = "COMMENTED";
    }),
    "M15 order-dependent: only the first review counts": rewrite(real, (x) => {
      const v = rowsOf(x)?.reviews?.value;
      if (v && Array.isArray(v.reviews)) v.reviews = v.reviews.slice(0, 1);
    }),
    "M16 open-set reason passed through": (c, p) => {
      const d = call(c, p);
      const reason = isPlain(c) && c.ok === false ? c.reason : null;
      if (d.decision === "UNKNOWN" && d.reasonCodes?.[0] === "malformed" && typeof reason === "string" && reason !== "malformed" && !CLOSED_REASONS.includes(reason)) return { ...d, reasonCodes: [reason] };
      const rows = rowsOf(c);
      for (const r of rows ? [rows.base, rows.ci, rows.external, rows.reviews] : []) {
        if (failRow(r) && typeof r.reason === "string" && !CLOSED_REASONS.includes(r.reason) && d.decision === "UNKNOWN" && d.reasonCodes?.[0] === "malformed") return { ...d, reasonCodes: [r.reason] };
      }
      return d;
    },
    "M17 humanMergeRequired false on CANDIDATE": (c, p) => {
      const d = call(c, p);
      return d.decision === "CANDIDATE_READY_FOR_HUMAN_REVIEW" ? { ...d, humanMergeRequired: false } : d;
    },
    "M18 nextAction copies the failure detail": (c, p) => {
      const d = call(c, p);
      return d.decision === "UNKNOWN" && typeof d.blocking?.detail === "string" ? { ...d, nextAction: `${d.nextAction} (${d.blocking.detail})` } : d;
    },
    "M19 whole-snapshot UNKNOWN (ARCH-01 §8, not row-scoped)": (c, p) => {
      const rows = rowsOf(c);
      if (rows) for (const [name, r] of [["base", rows.base], ["ci", rows.ci], ["external", rows.external], ["reviews", rows.reviews]] as [string, any][]) {
        if (failRow(r) && typeof r.reason === "string" && CLOSED_REASONS.includes(r.reason)) {
          const d = call(c, p);
          return { ...d, decision: "UNKNOWN", reasonCodes: [r.reason], blocking: { row: name, detail: r.detail } };
        }
      }
      return call(c, p);
    },
    "M20 blocking sources in input order (unsorted)": (c, p) => {
      const d = call(c, p);
      const rows = rowsOf(c);
      if ((d.decision === "EXTERNAL_BLOCKED" || d.decision === "EXTERNAL_PENDING") && rows && okRow(rows.external)) {
        const want = d.decision === "EXTERNAL_BLOCKED" ? "failure" : "pending";
        return { ...d, blocking: { sources: rows.external.value.external.filter((x: any) => x.state === want).map((x: any) => x.source) } };
      }
      return d;
    },
    "M21 reads the clock": (c, p) => {
      Date.now();
      return call(c, p);
    },
    "M22 reads a file": (c, p) => {
      try {
        fs.readFileSync("/dev/null");
      } catch {
        /* ignore */
      }
      return call(c, p);
    },
    "M23 reads the environment (credential)": (c, p) => {
      void process.env.HONE_ENG_READ_TOKEN;
      return call(c, p);
    },
    "M24 throws on hostile input": (c, p) => {
      JSON.stringify(c);
      if (isPlain(c)) void Object.keys(c);
      return call(c, p);
    },
    "M25 external success treated as pending": rewrite(real, (x) => {
      for (const e of rowsOf(x)?.external?.value?.external ?? []) if (e?.state === "success") e.state = "pending";
    }),
    "M26 malformed review elements skipped": (c, p) => {
      const x = tryClone(c);
      const v = rowsOf(x)?.reviews?.value;
      if (v && Array.isArray(v.reviews)) {
        v.reviews = v.reviews.filter((r: any) => isPlain(r) && typeof r.qualifiesAtHead === "boolean" && (r.actor === null || (isPlain(r.actor) && (r.actor.id === null || Number.isInteger(r.actor.id)) && typeof r.actor.type === "string")) && typeof r.channel === "string" && typeof r.verdict === "string");
        return call(x, p);
      }
      return call(c, p);
    },
    "M27 terminal flag trusted over key.state": rewrite(real, (x) => {
      if (isPlain(x?.evidence) && x.evidence.terminal === false && isPlain(x.evidence.key) && x.evidence.key.state !== "OPEN") x.evidence.key.state = "OPEN";
    }),
    "M28 NO_RUN (missing required CI) treated as SUCCEEDED": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && okRow(rows.ci) && rows.ci.value.outcome === "NO_RUN") rows.ci.value.outcome = "SUCCEEDED";
    }),
    "M29 resolver matched by id only": rewrite(real, (x) => {
      for (const t of rowsOf(x)?.reviews?.value?.threads ?? []) if (isPlain(t?.resolver) && t.resolver.id === HUMAN.id) t.resolver = { ...t.resolver, type: HUMAN.type };
    }),
    "M30 mutates its input": (c, p) => {
      const v = rowsOf(c)?.reviews?.value;
      if (v && Array.isArray(v.reviews) && !Object.isFrozen(v.reviews)) v.reviews.reverse();
      return call(c, p);
    },
    "M31 shared mutable state: memoizes decisions by evidenceHash": (c, p) => {
      const k = isPlain(c) && typeof c.evidenceHash === "string" ? c.evidenceHash : null;
      if (k !== null && memo.has(k)) return memo.get(k);
      const d = call(c, p);
      if (k !== null) memo.set(k, d);
      return d;
    },
    "M33 shared mutable state: every other CANDIDATE flips": (c, p) => {
      const d = call(c, p);
      if (d.decision !== "CANDIDATE_READY_FOR_HUMAN_REVIEW") return d;
      counter += 1;
      return counter % 2 === 0 ? { ...d, decision: "REVIEW_MISSING", reasonCodes: ["REVIEW_MISSING"] } : d;
    },
    // Pass 2 mutants (SPEC-05B df8dd9b5).
    "M34 out-of-enum verdict or channel treated as inert": rewrite(real, (x) => {
      for (const r of rowsOf(x)?.reviews?.value?.reviews ?? []) {
        if (!isPlain(r)) continue;
        if (typeof r.channel === "string" && !CHANNELS.includes(r.channel)) Object.assign(r, { channel: "PR_REVIEW", verdict: "DISMISSED" });
        if (typeof r.verdict === "string" && !ALL_VERDICTS.includes(r.verdict)) r.verdict = "DISMISSED";
      }
    }),
    "M35 evidence.schema not checked": rewrite(real, (x) => {
      if (isPlain(x?.evidence) && x.evidence.schema !== "eng-loop-v1/evidence@1") x.evidence.schema = "eng-loop-v1/evidence@1";
    }),
    "M36 applicableRunIds not checked": rewrite(real, (x) => {
      const ci = rowsOf(x)?.ci;
      if (okRow(ci) && "applicableRunIds" in ci.value && !(Array.isArray(ci.value.applicableRunIds) && ci.value.applicableRunIds.every((n: any) => Number.isInteger(n) && n > 0))) ci.value.applicableRunIds = [];
    }),
    "M37 malformed anywhere decides malformed (not row-scoped)": (c, p) => {
      const rows = rowsOf(c);
      const bad =
        rows &&
        ((okRow(rows.base) && !(Number.isInteger(rows.base.value.drift?.behindBy) && rows.base.value.drift.behindBy >= 0)) ||
          (okRow(rows.ci) && !CI_OUTCOMES.includes(rows.ci.value.outcome)) ||
          (okRow(rows.external) && !(Array.isArray(rows.external.value.external) && rows.external.value.external.every((e: any) => isPlain(e) && EXTERNAL_STATES.includes(e.state)))) ||
          (okRow(rows.reviews) && !(Array.isArray(rows.reviews.value.reviews) && rows.reviews.value.reviews.every((r: any) => isPlain(r) && CHANNELS.includes(r.channel) && ALL_VERDICTS.includes(r.verdict)))));
      const d = call(c, p);
      return bad ? { ...d, decision: "UNKNOWN", reasonCodes: ["malformed"], blocking: { row: "evidence", detail: "x" }, nextAction: call({ ok: false, reason: "malformed", detail: "x" }, p).nextAction } : d;
    },
    "M32 unknown CI outcome read as success (interprets GitHub enums)": rewrite(real, (x) => {
      const rows = rowsOf(x);
      if (rows && okRow(rows.ci) && ["success", "SUCCESS", "completed"].includes(rows.ci.value.outcome)) rows.ci.value.outcome = "SUCCEEDED";
    }),
  };
}
