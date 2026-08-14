import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// Consistency guards for the 2026-07-30 exact-production findings reconciliation.
// These prove the register is internally coherent and that a retired product
// direction cannot creep back in via a scheduled remediation item.

const DIR = join(process.cwd(), "docs/audits/2026-07-30");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const REG = JSON.parse(read("MASTER_FINDINGS_REGISTER.json"));
const CSV = read("MASTER_FINDINGS_REGISTER.csv");
// Current production head. The 60 findings were verified at AUDIT_SHA; production has
// since moved via PR #485 and PR #488 with no migration, and only the findings that
// delta touches were re-verified at the new head. Both SHAs are legitimate; which one a
// finding carries is a statement about where it was actually read.
const PROD_SHA = "395532489a07defd16d5c3a04ce26d2aedf46096";
const AUDIT_SHA = "c64366c9ba4130283932bbe21e32bf2ed62c4975";
const RE_VERIFIED_AT_NEW_HEAD = ["CHLOE-001", "CHLOE-002", "F-PAY-001"];

const Q = String.fromCharCode(34);
function parseCSV(txt: string): string[][] {
  const rows: string[][] = []; let cur: string[] = [], f = "", q = false;
  for (let i = 0; i < txt.length; i++) { const c = txt[i];
    if (q) { if (c === Q) { if (txt[i + 1] === Q) { f += Q; i++; } else q = false; } else f += c; }
    else { if (c === Q) q = true; else if (c === ",") { cur.push(f); f = ""; }
           else if (c === "\n") { cur.push(f); rows.push(cur); cur = []; f = ""; }
           else if (c !== "\r") f += c; } }
  if (f || cur.length) { cur.push(f); rows.push(cur); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}
const csvRows = parseCSV(CSV);
const csvHeader = csvRows[0];
const csvData = csvRows.slice(1);
const col = (name: string) => csvHeader.indexOf(name);

describe("findings register: CSV structural integrity", () => {
  // The first frozen-head review found the CSV shipped with 21 headers and 20
  // fields on every row: `production_reachable` was missing from the row builder,
  // silently shifting every later column left by one. A register whose columns do
  // not line up is worse than no register, so this is asserted first.
  it("every data row has exactly as many fields as the header", () => {
    const bad = csvData
      .map((r, i) => ({ line: i + 2, got: r.length }))
      .filter((x) => x.got !== csvHeader.length);
    expect(
      bad.slice(0, 5),
      `header has ${csvHeader.length} columns; ${bad.length} row(s) disagree`,
    ).toEqual([]);
  });

  it("the columns that must never be empty are populated on every row", () => {
    for (const name of ["source_register", "source_id", "source_original_severity"]) {
      const i = col(name);
      expect(i, `header is missing ${name}`).toBeGreaterThan(-1);
      const empty = csvData.filter((r) => !r[i]?.trim?.());
      expect(empty.length, `${name} empty on ${empty.length} row(s)`).toBe(0);
    }
  });
});

describe("findings register: source preservation", () => {
  it("every source finding appears exactly once per register", () => {
    const seen = new Map<string, number>();
    for (const r of csvData) {
      const key = `${r[col("source_register")]}::${r[col("source_id")]}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const dupes = [...seen.entries()].filter(([, n]) => n > 1);
    expect(dupes, `duplicated (register, source_id) pairs: ${JSON.stringify(dupes)}`).toEqual([]);
  });

  it("preserves all 48 July-27 findings, and the historical registers, without loss", () => {
    const byReg = (name: string) => csvData.filter((r) => r[col("source_register")].includes(name)).length;
    expect(byReg("Hone_Independent_Audit_2026-07-27.md")).toBe(48);
    expect(byReg("P1_MASTER_REGISTER_2026-07-18.csv")).toBe(34);
    expect(byReg("Hone_Findings_Register_2026-07-10.csv")).toBe(40);
    expect(byReg("Chloe production feedback")).toBe(5);
    expect(csvData.length).toBe(REG.counts.source_rows_in_csv_total);
  });

  it("every canonical finding has at least one source id", () => {
    for (const f of REG.findings) {
      expect(Array.isArray(f.source_ids) && f.source_ids.length >= 1, `${f.canonical_id} has no source`).toBe(true);
    }
  });

  it("canonical ids are unique", () => {
    const ids = REG.findings.map((f: { canonical_id: string }) => f.canonical_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findings register: classification integrity", () => {
  const OPEN_ISH = ["OPEN", "PARTIALLY_FIXED"];

  it("every OPEN/PARTIALLY_FIXED P0 or P1 has a remediation wave", () => {
    const offenders = REG.findings.filter(
      (f: any) => ["P0", "P1"].includes(f.current_severity) && OPEN_ISH.includes(f.current_status)
                  && (!f.remediation_wave || f.remediation_wave === "NONE"));
    expect(offenders.map((f: any) => f.canonical_id)).toEqual([]);
  });

  it("every finding has a launch gate", () => {
    const GATES = ["WILLOW_NOW","BEFORE_STUDIO_2","BEFORE_THREE_STUDIOS","BEFORE_TEN_STUDIOS",
      "BEFORE_PUBLIC_SELF_SERVICE","BEFORE_50_STUDIOS","POST_GA","NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION","NONE_CLOSED","NONE_SHIPPED"];
    for (const f of REG.findings) expect(GATES, `${f.canonical_id} gate=${f.launch_gate}`).toContain(f.launch_gate);
  });

  it("no RETIRED or SUPERSEDED finding is scheduled for implementation", () => {
    const bad = REG.findings.filter((f: any) =>
      ["RETIRED", "SUPERSEDED_BY_PRODUCT_DECISION"].includes(f.current_status) &&
      f.remediation_wave && f.remediation_wave !== "NONE");
    expect(bad.map((f: any) => `${f.canonical_id}:${f.remediation_wave}`)).toEqual([]);
  });

  it("every finding records the exact SHA it was verified against, and the delta is documented", () => {
    expect(REG.production_sha).toBe(PROD_SHA);
    expect(REG.audit_verification_sha).toBe(AUDIT_SHA);
    expect(REG.baseline_delta?.migrations_applied).toBe(0);
    expect(REG.baseline_delta?.hosted_migration_max_unchanged).toBe("0160");
    const bad = REG.findings.filter((f: any) => {
      const expected = RE_VERIFIED_AT_NEW_HEAD.includes(f.source_ids[0]) ? PROD_SHA : AUDIT_SHA;
      return f.last_verified_sha !== expected;
    });
    expect(bad.map((f: any) => `${f.source_ids[0]} ${f.last_verified_sha}`),
      "a finding must record the head it was actually verified against").toEqual([]);
    expect(REG.baseline_delta.findings_re_verified_at_new_head.sort()).toEqual([...RE_VERIFIED_AT_NEW_HEAD].sort());
  });

  it("no signed-record capability is scheduled in any remediation wave", () => {
    // Detect SCHEDULING, not mention. A sentence that forbids the retired work
    // ("must NOT be built", "explicitly off the roadmap") is exactly what we want
    // to see, so a bare keyword match would fire on the correct text.
    const BANNED = /snapshot ?-?v2|signed[- ]correction|re-?enable (the )?finalization|enable clinical_finalization/i;
    const NEGATED = /\b(not|never|no longer|must not|cannot|off the roadmap|retired|rejected|superseded|forbidden|do not|does not)\b/i;
    for (const f of REG.findings) {
      if (f.remediation_wave === "NONE") continue;
      const fields = [f.remediation_dependency, f.rollout_required, f.acceptance_evidence].filter(Boolean) as string[];
      for (const text of fields) {
        for (const sentence of text.split(/(?<=[.;])\s+/)) {
          if (!BANNED.test(sentence)) continue;
          expect(
            NEGATED.test(sentence),
            `${f.canonical_id} (wave ${f.remediation_wave}) appears to SCHEDULE retired signed-record ` +
              `work in a non-negated sentence: "${sentence.slice(0, 220)}"`,
          ).toBe(true);
        }
      }
    }
  });

  it("nothing closed, retired or product-decision-gated carries a remediation wave", () => {
    const CLOSED = ["PRODUCTION_VERIFIED", "DEPLOYED_NOT_VERIFIED", "RETIRED",
                    "SUPERSEDED_BY_PRODUCT_DECISION", "NOT_A_LAUNCH_REQUIREMENT", "FALSE_POSITIVE"];
    const bad = REG.findings.filter((f: any) =>
      (CLOSED.includes(f.current_status) || f.launch_gate === "NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION") &&
      f.remediation_wave !== "NONE");
    expect(bad.map((f: any) => `${f.canonical_id}:${f.current_status}:${f.remediation_wave}`)).toEqual([]);
  });

  it("the supersession map states the retirement is terminal for the historical enablement items", () => {
    const map = read("DUPLICATE_AND_SUPERSESSION_MAP.md");
    expect(map).toMatch(/HNE-REC-001/);
    expect(map).toMatch(/not a future enablement item/i);
    expect(map).toMatch(/no snapshot v2 will be built/i);
  });

  it("the clinical findings are reconciled against the retirement, not left as active P0/P1", () => {
    const find = (id: string) => REG.findings.find((f: any) => f.source_ids[0] === id);
    expect(find("F-CLIN-000").current_severity).not.toBe("P0");
    for (const id of ["F-CLIN-001", "F-CLIN-002"]) {
      expect(["SUPERSEDED_BY_PRODUCT_DECISION", "RETIRED"], id).toContain(find(id).current_status);
    }
  });
});

describe("findings register: counts agree across Markdown, CSV and JSON", () => {
  const sev = (s: string) => REG.findings.filter((f: any) => f.current_severity === s).length;

  it("JSON counts block matches the findings array and is self-describing", () => {
    expect(REG.counts.canonical_total).toBe(REG.findings.length);
    for (const [k, v] of Object.entries(REG.counts.canonical_by_severity)) expect(sev(k)).toBe(v);
    // The counts block must not imply the source rows live in `findings`.
    expect(REG.counts.note, "counts block must explain the CSV/JSON shape difference").toMatch(/canonical/i);
    expect(REG.counts).toHaveProperty("source_rows_in_csv_total");
  });

  it("the reconciliation report's P1 count matches the register", () => {
    const md = read("RECONCILIATION_REPORT.md");
    const m = md.match(/## C\. Current P1s \((\d+)\)/);
    expect(m, "P1 heading with a count not found").toBeTruthy();
    expect(Number(m![1])).toBe(sev("P1"));
  });

  it("the P0 claim is consistent everywhere", () => {
    expect(sev("P0")).toBe(0);
    expect(read("RECONCILIATION_REPORT.md")).toMatch(/Zero current P0 confirmed/i);
    expect(read("CURRENT_P0_P1_REPORT.md")).toMatch(/ZERO current P0 confirmed/i);
  });

  it("every P1 in the register appears in CURRENT_P0_P1_REPORT.md", () => {
    const rep = read("CURRENT_P0_P1_REPORT.md");
    for (const f of REG.findings.filter((x: any) => x.current_severity === "P1")) {
      expect(rep, `${f.source_ids[0]} missing from the P0/P1 report`).toContain(f.source_ids[0]);
    }
  });

  it("the input manifest records the mandatory audit and both unavailable optional artifacts", () => {
    const man = JSON.parse(read("AUDIT_INPUT_MANIFEST.json"));
    const primary = man.inputs.find((i: any) => i.role === "MANDATORY_PRIMARY_AUDIT");
    expect(primary.status).toBe("INGESTED");
    expect(primary.sha256).toBe("712a9f7acd3e3c0f929206023630b08777af893667177e95ac1c0689d4f82beb");
    const gone = man.inputs.filter((i: any) => i.status === "PERMANENTLY_UNAVAILABLE_THIS_RUN");
    expect(gone.map((i: any) => i.name).sort()).toEqual(["Hone_Findings.csv", "hone_evidence_excerpt.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Pass-2 guards. Each corresponds to a defect the first frozen-head review found.
// ---------------------------------------------------------------------------
describe("findings register: source preservation is diffed, not asserted", () => {
  // Pass 2 found five source columns dropped for every historical row, July-18
  // willow_impact and rationale on all 34, July-10 business impact / risk-at-stake /
  // confidence on all 40, while the map claimed full carry-through. The July-18
  // register is in-repo, so the claim is now proved by diff rather than by assertion.
  const j18Path = join(process.cwd(), "docs/roadmap/P1_MASTER_REGISTER_2026-07-18.csv");
  const j18 = parseCSV(readFileSync(j18Path, "utf8"));
  const j18Header = j18[0];
  const j18Rows = j18.slice(1);

  it("every non-empty July-18 source cell appears in some audit column", () => {
    const idIdx = j18Header.indexOf("original_id");
    // canonical_id / last_verified_date are the source register's own bookkeeping,
    // superseded by this register's canonical_id and last_verified_at columns.
    const skip = new Set(["canonical_id", "last_verified_date"]);
    const dropped: Record<string, number> = {};
    for (const srcRow of j18Rows) {
      const id = (srcRow[idIdx] ?? "").trim();
      if (!id) continue;
      const dest = csvData.find((r) => r[col("source_id")] === id && r[col("source_register")].includes("2026-07-18"));
      expect(dest, `July-18 row ${id} has no destination row`).toBeDefined();
      j18Header.forEach((h, k) => {
        const v = (srcRow[k] ?? "").trim();
        if (!v || skip.has(h)) return;
        if (!dest!.some((cell) => cell.includes(v))) dropped[h] = (dropped[h] ?? 0) + 1;
      });
    }
    expect(dropped, "a non-empty source cell landed in no audit column").toEqual({});
  });

  it("no audit column packs several source columns under an undocumented convention", () => {
    // The pass-1 register packed five July-18 status columns into
    // source_rollout_considerations as `code=…; migration=…; …`. Each now has its own column.
    for (const c of ["source_code_status", "source_migration_status", "source_deployment_status",
                     "source_enabled_status", "source_exercised_status"]) {
      expect(csvHeader, `${c} must be its own column`).toContain(c);
    }
    const packed = csvData
      .map((r, i) => ({ line: i + 2, v: r[col("source_rollout_considerations")] }))
      .filter((x) => /^(code|migration|deployment|enabled|exercised)=/.test(x.v));
    expect(packed.map((x) => x.line)).toEqual([]);
  });

  it("July-10 source columns land in columns whose names mean the same thing", () => {
    // Pass 1 filed `Existing controls` under source_production_evidence and
    // `Required regression tests` under source_test_limitations, inverting both.
    for (const c of ["source_existing_controls", "source_why_controls_insufficient",
                     "source_required_regression_tests", "source_reproduction",
                     "source_risk_at_stake", "source_business_impact", "source_confidence"]) {
      expect(csvHeader, `${c} must be its own column`).toContain(c);
    }
    const j10 = csvData.filter((r) => r[col("source_register")].includes("2026-07-10"));
    expect(j10.length).toBe(40);
    // The July-10 register has no test-limitations, rollout or production-evidence column,
    // so those must be empty rather than filled with the nearest-looking source field.
    for (const c of ["source_test_limitations", "source_rollout_considerations",
                     "source_production_evidence", "source_failure_scenario"]) {
      expect(j10.every((r) => r[col(c)] === ""), `${c} must be empty for July-10 rows`).toBe(true);
    }
    expect(j10.every((r) => r[col("source_existing_controls")] !== "")).toBe(true);
    expect(j10.filter((r) => r[col("source_business_impact")] !== "").length).toBe(40);
  });
});

describe("findings register: source preservation is real, not claimed", () => {
  const rowsOf = (reg: string) => csvData.filter((r) => r[col("source_register")].includes(reg));

  it("every July-10 row carries its acceptance criteria and recommended remediation", () => {
    const rows = rowsOf("Hone_Findings_Register_2026-07-10.csv");
    expect(rows.length).toBe(40);
    const acc = col("source_acceptance_criteria"), fix = col("source_recommended_fix");
    expect(rows.filter((r) => !r[acc]?.trim()).length, "July-10 rows missing acceptance criteria").toBe(0);
    expect(rows.filter((r) => !r[fix]?.trim()).length, "July-10 rows missing recommended remediation").toBe(0);
  });

  it("every July-18 row carries the disposition its own register recorded", () => {
    const rows = rowsOf("P1_MASTER_REGISTER_2026-07-18.csv");
    expect(rows.length).toBe(34);
    const disp = col("source_recorded_disposition");
    expect(rows.filter((r) => !r[disp]?.trim()).length, "July-18 rows missing classification").toBe(0);
    // the 8 rows that register already recorded as closed must remain visible
    const closed = rows.filter((r) => /DEPLOYED|PRODUCTION VERIFIED/i.test(r[disp]));
    expect(closed.length, "July-18 DEPLOYED/PRODUCTION VERIFIED rows must not be lost").toBe(8);
  });

  it("Chloe feedback rows are present and sanitized", () => {
    const rows = rowsOf("Chloe production feedback");
    expect(rows.length).toBe(5);
    const blob = rows.map((r) => r.join(" ")).join(" ");
    expect(blob, "no screenshot/image reference may be stored").not.toMatch(/\.(png|jpe?g|heic|webp)\b/i);
    expect(blob, "no client-name-like field may be stored").not.toMatch(/\bclient name\b|\bpatient\b/i);
    for (const id of ["CHLOE-001", "CHLOE-002", "CHLOE-003", "CHLOE-004", "CHLOE-005"]) {
      expect(rows.some((r) => r[col("source_id")] === id), `${id} missing`).toBe(true);
    }
  });
});

describe("findings register: trains, PRs and gates", () => {
  const OPENISH = ["OPEN", "PARTIALLY_FIXED", "EVIDENCE_LIMITATION"];
  const TRAIN = readFileSync(join(DIR, "FIRST_REMEDIATION_PR_TRAIN.md"), "utf8");

  it("every open P0/P1 has a train and at least one concrete PR", () => {
    const bad = REG.findings.filter((f: any) =>
      ["P0", "P1"].includes(f.current_severity) && OPENISH.includes(f.current_status) &&
      (!f.train || f.train === "NONE" || !(f.required_prs || []).length));
    expect(bad.map((f: any) => f.canonical_id)).toEqual([]);
  });

  it("every PR named by a finding exists in the PR train document", () => {
    const prs = [...new Set(REG.findings.flatMap((f: any) => f.required_prs || []))] as string[];
    for (const pr of prs) expect(TRAIN, `${pr} referenced but not in the train`).toContain(`**${pr}**`);
  });

  it("a PR claims to CLOSE a gate only when it covers every open finding at that gate", () => {
    const openAt = (g: string) => REG.findings.filter((f: any) => f.launch_gate === g && OPENISH.includes(f.current_status));
    for (const m of TRAIN.matchAll(/\| \*\*(PR-\d+)\*\*[^\n]*?\| (Closes|Contributes to) ([A-Z_0-9]+)/g)) {
      const [, pr, verb, gate] = m;
      if (verb !== "Closes") continue;
      const covered = REG.findings.filter((f: any) => (f.required_prs || []).includes(pr) && f.launch_gate === gate);
      const open = openAt(gate);
      expect(open.every((f: any) => covered.some((c: any) => c.canonical_id === f.canonical_id)),
        `${pr} claims to close ${gate} but does not cover every open finding there`).toBe(true);
    }
  });

  it("the finding dependency graph is acyclic", () => {
    const byId: Record<string, any> = {};
    for (const f of REG.findings) byId[f.source_ids[0]] = f;
    const walk = (id: string, seen: string[]): string[] | null => {
      if (seen.includes(id)) return [...seen, id];
      const f = byId[id];
      if (!f) return null;
      for (const d of f.depends_on ?? []) { const r = walk(d, [...seen, id]); if (r) return r; }
      return null;
    };
    const cycles = REG.findings.map((f: any) => walk(f.source_ids[0], [])).filter(Boolean);
    expect(cycles, "canonical depends_on must be acyclic").toEqual([]);
  });

  // Pass 2 mutation-proved the previous version of this guard useless: deleting real
  // "Depends on" cells from the PR train left the suite 34/34 green, so every PR
  // ordering edge, including the L18 app-first constraint, was unguarded. This
  // version reads the train table itself.
  it("every PR's stated dependencies match the derived graph, and PR-11 waits for PR-10 deployed", () => {
    const train = read("FIRST_REMEDIATION_PR_TRAIN.md");
    const rows = train.split("\n").filter((l) => /^\| \*\*PR-\d+\*\*/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(20);

    const stated: Record<string, string> = {};
    for (const r of rows) {
      const cells = r.split("|").map((c) => c.trim());
      const pr = cells[1].replace(/\*/g, "");
      stated[pr] = cells[5];
    }
    const derived = REG.pr_dependencies;
    expect(Object.keys(derived).length).toBe(Object.keys(stated).length);
    for (const [pr, deps] of Object.entries(derived) as [string, string[]][]) {
      const cell = stated[pr];
      expect(cell, `${pr} missing from the PR train table`).toBeDefined();
      if (deps.length === 0) {
        expect(cell, `${pr} claims a dependency the derived graph does not have`).toBe("—");
      } else {
        for (const d of deps) {
          expect(cell, `${pr} must state its derived dependency ${d}`).toContain(d);
        }
      }
    }
    // The single highest-risk ordering constraint in the audit, asserted explicitly.
    expect(derived["PR-11"], "L18 cannot be solved revoke-first").toContain("PR-10 deployed");
    expect(stated["PR-11"]).toContain("PR-10 deployed");
  });

  it("the PR dependency graph is acyclic", () => {
    const g = REG.pr_dependencies as Record<string, string[]>;
    const walk = (id: string, seen: string[]): string[] | null => {
      if (seen.includes(id)) return [...seen, id];
      for (const d of (g[id] ?? []).map((x) => x.replace(" deployed", ""))) {
        const r = walk(d, [...seen, id]); if (r) return r;
      }
      return null;
    };
    expect(Object.keys(g).map((k) => walk(k, [])).filter(Boolean)).toEqual([]);
  });

  // A code-only P1 packaged with migration work needs migration-only authorization
  // it does not need, which delays a live defect behind a heavier approval path.
  it("no code-only P1 is trapped behind migration authorization", () => {
    const byPR: Record<string, any[]> = {};
    for (const f of REG.findings) for (const p of f.required_prs ?? []) (byPR[p] ??= []).push(f);
    const migOf = (f: any, p: string) =>
      f.migration_required_by_pr && p in f.migration_required_by_pr
        ? f.migration_required_by_pr[p]
        : Boolean(f.migration_required);
    const trapped = REG.findings.filter(
      (f: any) =>
        f.current_severity === "P1" &&
        !f.migration_required &&
        (f.required_prs ?? []).length > 0 &&
        f.required_prs.every((p: string) => (byPR[p] ?? []).some((g: any) => migOf(g, p))),
    );
    expect(trapped.map((f: any) => f.source_ids[0])).toEqual([]);
  });

  // The PR train's Migration and Rollback columns are derived, not asserted:
  // pass 2 found PR-13 and PR-15 marked "no" while their own findings required one.
  it("each PR's Migration and Rollback cells match its findings", () => {
    const train = read("FIRST_REMEDIATION_PR_TRAIN.md");
    const byPR: Record<string, any[]> = {};
    for (const f of REG.findings) for (const p of f.required_prs ?? []) (byPR[p] ??= []).push(f);
    const migOf = (f: any, p: string) =>
      f.migration_required_by_pr && p in f.migration_required_by_pr
        ? f.migration_required_by_pr[p]
        : Boolean(f.migration_required);
    const bad: string[] = [];
    for (const line of train.split("\n").filter((l) => /^\| \*\*PR-\d+\*\*/.test(l))) {
      const cells = line.split("|").map((c) => c.trim());
      const pr = cells[1].replace(/\*/g, "");
      const expectMig = (byPR[pr] ?? []).some((f) => migOf(f, pr));
      const gotMig = /yes/i.test(cells[6]);
      const gotRollback = cells[9];
      if (gotMig !== expectMig) bad.push(`${pr} migration cell says ${gotMig}, findings say ${expectMig}`);
      if (expectMig && !/forward-fix/i.test(gotRollback)) bad.push(`${pr} migration PR must forward-fix`);
      if (!expectMig && !/revert the PR/i.test(gotRollback)) bad.push(`${pr} non-migration PR rolls back by revert`);
    }
    expect(bad).toEqual([]);
  });

  it("a closed finding carries no forward gate and no schedule", () => {
    // NOT_A_LAUNCH_REQUIREMENT is excluded deliberately: it means "not required for the
    // current phase", and its gate records the phase at which it WOULD become required.
    // The statuses below are terminal, a forward gate on any of them is a contradiction.
    // DEPLOYED_NOT_VERIFIED means the fix shipped but the reporter has not accepted it.
    // It carries no forward gate and no remediation, like the other terminal statuses.
    const CLOSED = ["RETIRED", "SUPERSEDED_BY_PRODUCT_DECISION",
                    "PRODUCTION_VERIFIED", "DEPLOYED_NOT_VERIFIED", "FALSE_POSITIVE"];
    const FORWARD = ["WILLOW_NOW", "BEFORE_STUDIO_2", "BEFORE_THREE_STUDIOS", "BEFORE_TEN_STUDIOS",
                     "BEFORE_PUBLIC_SELF_SERVICE", "BEFORE_50_STUDIOS", "POST_GA"];
    const bad = REG.findings
      .filter((f: any) => CLOSED.includes(f.current_status))
      .filter((f: any) => FORWARD.includes(f.launch_gate) || f.train !== "NONE" || (f.required_prs ?? []).length);
    expect(bad.map((f: any) => `${f.source_ids[0]} ${f.current_status}/${f.launch_gate}/${f.train}`)).toEqual([]);
  });

  it("status and launch gate are compatible", () => {
    const CLOSED = ["PRODUCTION_VERIFIED", "RETIRED", "SUPERSEDED_BY_PRODUCT_DECISION", "NOT_A_LAUNCH_REQUIREMENT", "FALSE_POSITIVE"];
    const bad = REG.findings.filter((f: any) => CLOSED.includes(f.current_status) && f.train !== "NONE");
    expect(bad.map((f: any) => `${f.canonical_id}:${f.current_status}:${f.train}`)).toEqual([]);
  });
});

describe("findings register: pass-2 corrections hold", () => {
  const find = (id: string) => REG.findings.find((f: any) => f.source_ids[0] === id);

  it("F-PAY-001 is P1 and scheduled", () => {
    const f = find("F-PAY-001");
    expect(f.current_severity).toBe("P1");
    expect(f.production_reachable).toBe(true);
    expect(["BEFORE_STUDIO_2", "WILLOW_NOW"]).toContain(f.launch_gate);
    expect((f.required_prs || []).length).toBeGreaterThan(0);
  });

  it("the live public-claim defect is its own OPEN finding, split from F-BILL-001", () => {
    const doc = find("N-DOC-001"), bill = find("F-BILL-001");
    expect(doc, "N-DOC-001 must exist").toBeTruthy();
    expect(doc.current_status).toBe("OPEN");
    expect((doc.required_prs || []).length).toBeGreaterThan(0);
    expect(bill.current_status).toBe("NOT_A_LAUNCH_REQUIREMENT");
    expect(bill.train).toBe("NONE");
  });

  it("L18-L21 are first-class canonical rows", () => {
    for (const id of ["L18", "L19a", "L19b", "L20", "L21"]) {
      const f = find(id);
      expect(f, `${id} must be a canonical row`).toBeTruthy();
      expect(f.launch_gate).toBeTruthy();
      expect(f.exact_hosted_evidence.length).toBeGreaterThan(20);
    }
    expect(find("L19a").production_reachable, "TRUNCATE grants are not browser-reachable").toBe(false);
  });

  // Pass 2 mutation-proved the original guard vacuous: it grepped CURRENT_P0_P1_REPORT.md
  // for "practitioner count is unknown", a phrase that appears in no artifact, while six
  // live locations still said the count could not be determined. It now scans the corpus.
  it("one authoritative Willow practitioner fact is stated, and nothing still calls it unknown", () => {
    expect(REG.willow_practitioner_fact).toMatch(/1 ACTIVE owner/);
    expect(REG.willow_practitioner_fact).toMatch(/[Aa]ctive non-owner practitioners: 0/);

    // Pass 3 mutation-proved the first version too narrow: it matched only the active
    // voice, so "I also have no evidence of the number of non-owner practitioners"
    // passed. The count is hosted-verified; no phrasing may still call it open.
    const STALE = /(could not (be )?(determine|determined|establish|established)|no evidence of|cannot say how many|not established|undetermined|unknown)[^.]{0,140}(practitioner|non-owner)/i;
    const offenders: string[] = [];
    for (const f of REG.findings) {
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === "string" && STALE.test(v)) offenders.push(`${f.source_ids[0]}.${k}`);
      }
    }
    for (const doc of ["CURRENT_P0_P1_REPORT.md", "EVIDENCE_LIMITATIONS.md", "RECONCILIATION_REPORT.md"]) {
      if (STALE.test(read(doc))) offenders.push(doc);
    }
    expect(offenders, "the Willow practitioner count is hosted-verified; nothing may still call it undetermined").toEqual([]);
  });

  // The escalation rule must be stated in terms of ACTIVE non-owner practitioners.
  // Willow HAS a non-owner practitioner row (inactive), so an unqualified
  // "if Willow already has an employee practitioner" reads as already triggered.
  it("the payment gate's escalation rule is qualified by ACTIVE, not merely by existence", () => {
    const pay = REG.findings.find((f: any) => f.source_ids[0] === "F-PAY-001");
    const text = `${pay.missing_evidence} ${pay.rationale} ${pay.Willow_risk}`;
    // Pass 3: the gate is WILLOW_NOW because the AMOUNT half is live today regardless of
    // practitioner count; only the AUTHORIZATION half is bounded to the owner.
    expect(pay.launch_gate).toBe("WILLOW_NOW");
    expect(text).toMatch(/ACTIVE non-owner|active non-owner/);
    expect(text).not.toMatch(/if Willow already has an employee practitioner/i);
  });

  it("the reconciliation report has contiguous section lettering A–I", () => {
    const md = readFileSync(join(DIR, "RECONCILIATION_REPORT.md"), "utf8");
    for (const L of ["A", "B", "C", "D", "E", "F", "G", "H", "I"]) {
      expect(md, `section ${L} missing`).toMatch(new RegExp(`^## ${L}\\. `, "m"));
    }
  });

  it("every gate used is defined in the gate matrix", () => {
    const gm = readFileSync(join(DIR, "LAUNCH_GATE_MATRIX.md"), "utf8");
    for (const g of [...new Set(REG.findings.map((f: any) => f.launch_gate))] as string[]) {
      expect(gm, `${g} is used but not defined`).toContain(`**${g}**`);
    }
  });
});

describe("findings register: pass-2 review corrections hold", () => {
  const OPEN = ["OPEN", "PARTIALLY_FIXED"];
  const openish = REG.findings.filter((f: any) => OPEN.includes(f.current_status));

  it("acceptance evidence states what would close the finding, not what tests exist", () => {
    const echoed = REG.findings.filter((f: any) => f.acceptance_evidence === f.behavioural_test_evidence);
    expect(echoed.map((f: any) => f.source_ids[0]), "acceptance_evidence must not restate behavioural_test_evidence").toEqual([]);
    const missing = openish.filter((f: any) => !f.acceptance_evidence || f.acceptance_evidence.length < 30);
    expect(missing.map((f: any) => f.source_ids[0])).toEqual([]);
  });

  it("EVIDENCE_LIMITATION is never counted as open, in any report", () => {
    expect(REG.open_status_convention).toMatch(/EVIDENCE_LIMITATION is NOT counted as open/);
    const byGate: Record<string, number> = {};
    for (const f of openish) byGate[f.launch_gate] = (byGate[f.launch_gate] ?? 0) + 1;
    expect(REG.counts.canonical_open_or_partial).toBe(openish.length);
    expect(REG.counts.canonical_open_or_partial_by_gate).toEqual(byGate);

    const gateDoc = read("LAUNCH_GATE_MATRIX.md");
    for (const [gate, count] of Object.entries(byGate)) {
      const heading = new RegExp(`### ${gate} — ${count} open/partial`);
      expect(gateDoc, `${gate} heading must report ${count} open/partial`).toMatch(heading);
    }
    // CHLOE-002 was the only EVIDENCE_LIMITATION row and PR #488 discharged it, so the
    // set is now empty. Any new one must be deliberate, not a silent reclassification.
    const el = REG.findings.filter((f: any) => f.current_status === "EVIDENCE_LIMITATION");
    expect(el.map((f: any) => f.source_ids[0])).toEqual([]);
  });

  it("every open finding either has a PR or a stated reason it is unscheduled", () => {
    const unscheduled = openish.filter((f: any) => (f.required_prs ?? []).length === 0);
    const silent = unscheduled.filter((f: any) => !f.unscheduled_reason);
    expect(silent.map((f: any) => f.source_ids[0]), "silent truncation reads as full coverage").toEqual([]);
    // Nothing above P3 may be left out of the first tranche.
    expect(unscheduled.filter((f: any) => f.current_severity !== "P3").map((f: any) => f.source_ids[0])).toEqual([]);
    const plan = read("DEPENDENCY_REMEDIATION_PLAN.md");
    for (const f of unscheduled) expect(plan, `${f.source_ids[0]} must be listed as unscheduled`).toContain(f.source_ids[0]);
  });

  it("the dependency plan's train membership equals canonical train membership", () => {
    const plan = read("DEPENDENCY_REMEDIATION_PLAN.md");
    const trains: Record<string, string[]> = {};
    for (const f of REG.findings) {
      if (!f.train || f.train === "NONE") continue;
      (trains[f.train] ??= []).push(f.source_ids[0]);
    }
    for (const [t, members] of Object.entries(trains)) {
      const row = plan.split("\n").find((l) => l.startsWith(`| **${t}**`));
      expect(row, `train ${t} missing from the plan`).toBeDefined();
      for (const m of members) expect(row, `${t} must list ${m}`).toContain(m);
      // and must not list a finding that is not in that train
      // Column 2 is the Findings cell. Column 4 holds per-finding dependencies, whose
      // targets legitimately live in other trains, so it must not be scanned here.
      const findingsCell = row!.split("|")[2];
      const listed = [...findingsCell.matchAll(/`([A-Z0-9-]+)`/g)].map((m) => m[1]);
      const strayFindings = listed.filter((x) => !members.includes(x));
      expect(strayFindings, `${t} lists a finding whose canonical train is different`).toEqual([]);
    }
  });

  it("a closed finding outside the clinical domain carries no signed-record product decision", () => {
    const bad = REG.findings.filter(
      (f: any) => !/^F-CLIN-/.test(f.source_ids[0]) && /signed-record/.test(f.product_decision ?? ""),
    );
    expect(bad.map((f: any) => f.source_ids[0])).toEqual([]);
    const exec = REG.findings.find((f: any) => f.source_ids[0] === "F-EXEC-001");
    expect(exec.product_decision).toBe("n/a");
    expect(exec.launch_gate).not.toBe("POST_GA");
  });

  it("the CI evidence for F-EXEC-001 names one run, and the evidence appendix names the same one", () => {
    const exec = REG.findings.find((f: any) => f.source_ids[0] === "F-EXEC-001");
    expect(exec.current_status).toBe("RETIRED");
    expect(exec.exact_hosted_evidence).toContain("30572200532");
    expect(exec.exact_hosted_evidence).toContain(AUDIT_SHA);
    const ev = read("EVIDENCE_LIMITATIONS.md");
    expect(ev).toContain("30572200532");
    // the audit branch's own run must not be presented as production evidence
    expect(ev).not.toContain("30577864921");
  });

  it("no finding still cites the Upstash configuration question that F-OPS-001 closed", () => {
    // Pass 3 mutation-proved the first version too narrow: it read missing_evidence
    // only, with one literal phrase, so F-SCALE-002's exact_hosted_evidence kept the
    // resolved question and F-SCHED-003's original phrasing would have passed.
    const STALE = /(whether|if)[^.]{0,80}(upstash|rate.limit)[^.]{0,80}(configured|env vars|are set)/i;
    const stale: string[] = [];
    for (const f of REG.findings) {
      if (f.source_ids[0] === "F-OPS-001") continue; // the finding that RESOLVES it
      for (const [k, v] of Object.entries(f)) {
        if (typeof v === "string" && STALE.test(v) && !/CLOSED by F-OPS-001|closed by F-OPS-001/.test(v)) {
          stale.push(`${f.source_ids[0]}.${k}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("F-CLIN-004 is P1 and the demotion basis no longer rests on reversibility alone", () => {
    const f = REG.findings.find((x: any) => x.source_ids[0] === "F-CLIN-004");
    expect(f.current_severity).toBe("P1");
    expect(f.launch_gate).toBe("WILLOW_NOW");
    expect((f.required_prs ?? []).length).toBeGreaterThan(0);
  });

  it("the published-retention claim is gated like the other live false claims", () => {
    const ret = REG.findings.find((x: any) => x.source_ids[0] === "F-RET-001");
    const doc = REG.findings.find((x: any) => x.source_ids[0] === "N-DOC-001");
    const comp = REG.findings.find((x: any) => x.source_ids[0] === "F-COMP-001");
    expect(doc.launch_gate).toBe("WILLOW_NOW");
    expect(comp.launch_gate).toBe("WILLOW_NOW");
    expect(ret.launch_gate, "a live published claim is WILLOW_NOW regardless of when its implementation lands").toBe("WILLOW_NOW");
    expect(ret.required_prs).toContain("PR-02");
  });

  it("the recommended first authorization states a derived fact, not a superlative", () => {
    const train = read("FIRST_REMEDIATION_PR_TRAIN.md");
    expect(train).not.toMatch(/the only two[^.]*P1s/i);
    const codeOnly = REG.findings.filter(
      (f: any) =>
        f.current_severity === "P1" && OPEN.includes(f.current_status) && !f.migration_required &&
        ["WILLOW_NOW", "BEFORE_STUDIO_2"].includes(f.launch_gate),
    );
    expect(train, "the count of code-only P1s must be stated and correct").toContain(`${codeOnly.length} open P1s`);
    for (const f of codeOnly) expect(train).toContain(f.source_ids[0]);
  });

  it("every review item in all four passes has a final disposition and no artifact contradicts it", () => {
    const closure = read("REVIEW_CLOSURE_REGISTER.md");
    // Both tables carry the disposition in a **bolded** cell; read that cell alone.
    // Scanning the whole row matches quoted prose (e.g. a correction that says an item
    // "was open"), which is exactly the kind of false trigger this suite has to avoid.
    const rows = closure
      .split("\n")
      .filter((l) => /^\| \d+ \| P[123] \| \*\*/.test(l))
      .map((l) => ({ n: l.split("|")[1].trim(), disposition: l.split("|")[3].trim() }));
    expect(rows.length, "33 pass-1 + 25 pass-2 + 33 pass-3 + 23 pass-4 items").toBe(114);
    const FINAL = /^\*\*(CORRECTED_AND_VERIFIED|REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED|DUPLICATE_OF_REVIEW_ITEM_\d+|REFUTED)\*\*$/;
    const notFinal = rows.filter((r) => !FINAL.test(r.disposition));
    expect(notFinal, "every review item needs a final disposition").toEqual([]);
    // Every DUPLICATE must point at a real item other than itself.
    for (const r of rows) {
      const m = r.disposition.match(/DUPLICATE_OF_REVIEW_ITEM_(\d+)/);
      if (!m) continue;
      expect(Number(m[1])).toBeGreaterThanOrEqual(1);
      expect(Number(m[1])).toBeLessThanOrEqual(33);
      expect(m[1]).not.toBe(r.n);
    }
    // The pass-1 artifact must not contradict the closure register.
    const pass1 = read("INDEPENDENT_REVIEW_FINDINGS.md");
    const contradictions = pass1.split("\n").filter((l) => /^\| \d+ \|/.test(l) && /OPEN — deferred/.test(l));
    expect(contradictions, "INDEPENDENT_REVIEW_FINDINGS.md must not mark an item open that the closure register closes").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pass-3 derivation guards.
//
// The pass-3 independent review mutation-proved that almost every human-readable
// artifact was unguarded: the production SHA could be falsified in all nine
// documents, three live P1s could be downgraded in the CSV, the gate matrix could
// lose its blocker bullets, and whole report files could be replaced, all with
// the suite fully green. The register is only trustworthy if the documents a
// reader actually opens are DERIVED from it and checked here.
// ---------------------------------------------------------------------------

const MD_FILES = [
  "RECONCILIATION_REPORT.md", "CURRENT_P0_P1_REPORT.md", "P2_DISPOSITION_REPORT.md",
  "LAUNCH_GATE_MATRIX.md", "DEPENDENCY_REMEDIATION_PLAN.md", "FIRST_REMEDIATION_PR_TRAIN.md",
  "DUPLICATE_AND_SUPERSESSION_MAP.md", "EVIDENCE_LIMITATIONS.md", "REVIEW_CLOSURE_REGISTER.md",
  "INDEPENDENT_REVIEW_FINDINGS.md",
];
const OPEN_STATUSES = ["OPEN", "PARTIALLY_FIXED"];
const openish = () => REG.findings.filter((f: any) => OPEN_STATUSES.includes(f.current_status));
const findingBy = (id: string) => REG.findings.find((f: any) => f.source_ids[0] === id);
const prMembers = (pr: string) => REG.findings.filter((f: any) => (f.required_prs ?? []).includes(pr));
const canonRows = () => csvData.filter((r) => r[col("canonical_id")] !== "UNMAPPED_HISTORICAL" && r[col("canonical_id")] !== "");

describe("findings register: every artifact carries the same baseline", () => {
  // Mutation-proved gap: the SHA and migration max could be falsified in all nine
  // Markdown files while the suite stayed green. Every document's H1 states the
  // baseline as its provenance claim, so every document must be checked.
  const ALLOWED_OTHER_SHAS = new Set([
    "1468d051b5ed5bbcf2d8909b23bf4e9c1b6aeee0", // pass-1 review head, named as such
    "7566a9c82f5ca8eb0ba86bac90b8c5ca2eac67ef", // pass-2 review head, named as such
    "0e5357404eab654769dd9765ca46105f96050d7f", // pass-3 review head, named as such
    "c64366c9ba4130283932bbe21e32bf2ed62c4975", // the audit verification head, named as such
    "058b8bcbd1a80d6aa89c47f9357e1964328f220d", // the July-27 audit's own §1.2 ZIP comment
  ]);

  it("no artifact states a production SHA other than the audited one", () => {
    const bad: string[] = [];
    for (const f of MD_FILES) {
      for (const m of read(f).matchAll(/\b[0-9a-f]{40}\b/g)) {
        if (m[0] !== PROD_SHA && !ALLOWED_OTHER_SHAS.has(m[0])) bad.push(`${f}: ${m[0]}`);
      }
    }
    expect(bad, "an artifact cites a 40-hex SHA that is neither the production baseline nor a named review head").toEqual([]);
  });

  it("no artifact states a hosted migration max other than the audited one", () => {
    const bad: string[] = [];
    for (const f of MD_FILES) {
      for (const m of read(f).matchAll(/migration max[^0-9]{0,4}(\d{4})/gi)) {
        if (m[1] !== REG.hosted_migration_max) bad.push(`${f}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
    expect(REG.hosted_migration_max).toBe("0160");
  });

  it("no artifact cites evidence by an absolute local filesystem path", () => {
    const bad = MD_FILES.filter((f) => /\/Users\/[a-z]/i.test(read(f)));
    expect(bad, "evidence must be citable by anyone with the repository").toEqual([]);
    expect(JSON.stringify(REG)).not.toMatch(/\/Users\/[a-z]/i);
  });
});

describe("findings register: the CSV and the JSON cannot disagree", () => {
  // Mutation-proved gap: F-PAY-001, F-CLIN-004 and N-DOC-001 could each be set to
  // P3 / PRODUCTION_VERIFIED / POST_GA / no-PR in the CSV, the file a non-engineer
  // opens, while the JSON still held them as live P1s, and the suite stayed green.
  it("every canonical CSV row matches the JSON field for field", () => {
    const bad: string[] = [];
    for (const r of canonRows()) {
      const f = REG.findings.find((x: any) => x.canonical_id === r[col("canonical_id")]);
      if (!f) { bad.push(`${r[col("source_id")]}: canonical_id not in the JSON`); continue; }
      const expected: Record<string, string> = {
        current_severity: f.current_severity,
        current_status: f.current_status,
        current_exposure: f.current_exposure,
        production_reachable: String(Boolean(f.production_reachable)),
        launch_gate: f.launch_gate,
        train: f.train,
        required_prs: (f.required_prs ?? []).join(" "),
        depends_on: (f.depends_on ?? []).join(" "),
        unscheduled_reason: f.unscheduled_reason ?? "",
        last_verified_sha: f.last_verified_sha,
      };
      for (const [k, v] of Object.entries(expected)) {
        if (r[col(k)] !== v) bad.push(`${r[col("source_id")]}.${k}: CSV="${r[col(k)]}" JSON="${v}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the preserved source content is pinned by digest, so a source cell cannot be emptied", () => {
    // Two of the three source registers live outside the repository, so content
    // fidelity cannot be re-diffed here. It is pinned instead.
    const manifest = JSON.parse(read("AUDIT_INPUT_MANIFEST.json"));
    const pinned = manifest.preserved_source_content_digests;
    expect(pinned, "the manifest must pin the preserved source content").toBeDefined();

    const SEP1 = String.fromCharCode(1), SEP2 = String.fromCharCode(2);
    const srcCols = csvHeader.map((n, i) => ({ n, i })).filter((x) => x.n.startsWith("source_"));
    const per: Record<string, string[]> = {};
    for (const r of csvData) {
      const reg = r[col("source_register")];
      const key = reg.includes("2026-07-27") ? "july_27"
                : reg.includes("2026-07-18") ? "july_18"
                : reg.includes("2026-07-10") ? "july_10"
                : reg.includes("Chloe") ? "chloe" : "discovered";
      (per[key] ??= []).push(r[col("source_id")] + SEP1 + srcCols.map((c) => r[c.i]).join(SEP1));
    }
    for (const [key, lines] of Object.entries(per)) {
      lines.sort();
      const got = createHash("sha256").update(lines.join(SEP2)).digest("hex");
      expect(pinned.digests[key], `no digest pinned for ${key}`).toBeDefined();
      expect(lines.length, `${key} row count changed`).toBe(pinned.digests[key].rows);
      expect(got, `${key} preserved source content changed, a source cell was emptied, truncated or rewritten`)
        .toBe(pinned.digests[key].sha256);
    }
  });

  it("the manifest's own checksums match the files they describe", () => {
    const manifest = JSON.parse(read("AUDIT_INPUT_MANIFEST.json"));
    const bad: string[] = [];
    const walk = (o: any) => {
      if (Array.isArray(o)) return o.forEach(walk);
      if (!o || typeof o !== "object") return;
      if (typeof o.path === "string" && o.path.includes("docs/audits/2026-07-30/") && typeof o.sha256 === "string") {
        const name = o.path.split("/").pop()!;
        const got = createHash("sha256").update(readFileSync(join(DIR, name))).digest("hex");
        if (got !== o.sha256) bad.push(`${name}: manifest ${o.sha256.slice(0, 12)} vs actual ${got.slice(0, 12)}`);
      }
      Object.values(o).forEach(walk);
    };
    walk(manifest);
    expect(bad, "the manifest must not drift from the artifacts it checksums").toEqual([]);
  });
});

describe("findings register: the reports are derived, not written", () => {
  it("LAUNCH_GATE_MATRIX.md's summary table matches the register row for row", () => {
    const doc = read("LAUNCH_GATE_MATRIX.md");
    const gates = [...new Set(REG.findings.map((f: any) => f.launch_gate))] as string[];
    const bad: string[] = [];
    for (const g of gates) {
      const all = REG.findings.filter((f: any) => f.launch_gate === g);
      const row = doc.split("\n").find((l) => l.startsWith(`| **${g}**`));
      if (!row) { bad.push(`${g}: missing from the summary table`); continue; }
      const cells = row.split("|").map((c) => c.trim());
      const want = [
        all.length,
        all.filter((f: any) => OPEN_STATUSES.includes(f.current_status)).length,
        all.filter((f: any) => f.current_status === "EVIDENCE_LIMITATION").length,
        all.filter((f: any) => f.current_severity === "P1").length,
        all.filter((f: any) => f.current_severity === "P2").length,
        all.filter((f: any) => f.current_severity === "P3").length,
      ];
      const got = cells.slice(3, 9).map(Number);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`${g}: table ${got} vs register ${want}`);
    }
    expect(bad).toEqual([]);
  });

  it("LAUNCH_GATE_MATRIX.md lists exactly the open blockers at each gate", () => {
    const doc = read("LAUNCH_GATE_MATRIX.md");
    const sections = doc.split(/^### /m).slice(1);
    const bad: string[] = [];
    for (const s of sections) {
      const gate = s.split(" ")[0];
      const listed = new Set([...s.matchAll(/^- `([A-Za-z0-9-]+)`/gm)].map((m) => m[1]));
      // The section lists open blockers AND, in its own labelled subsection, any
      // evidence-limited row at that gate, which the heading advertises and which
      // must therefore be visible rather than merely counted.
      const expected = new Set<string>(
        REG.findings
          .filter((f: any) => f.launch_gate === gate &&
            (OPEN_STATUSES.includes(f.current_status) || f.current_status === "EVIDENCE_LIMITATION"))
          .map((f: any) => String(f.source_ids[0])),
      );
      for (const id of expected) if (!listed.has(id)) bad.push(`${gate}: ${id} belongs in this section but is not listed`);
      for (const id of listed) if (!expected.has(id)) bad.push(`${gate}: ${id} is listed but does not belong there`);
      // every "(N)" sub-count must equal the bullets that follow it
      const groups = s.split(/\*\*(.+?) \((\d+)\)\*\*/).slice(1);
      for (let i = 0; i + 2 < groups.length + 1; i += 3) {
        const claimed = Number(groups[i + 1]);
        const body = groups[i + 2] ?? "";
        const n = (body.match(/^- `/gm) ?? []).length;
        if (claimed !== n) bad.push(`${gate}/${groups[i]}: claims ${claimed}, lists ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("CURRENT_P0_P1_REPORT.md lists every P1, and no others, with the right count", () => {
    const doc = read("CURRENT_P0_P1_REPORT.md");
    const p1 = REG.findings.filter((f: any) => f.current_severity === "P1");
    expect(doc).toContain(`## Current P1 findings (${p1.length})`);
    const table = doc.slice(doc.indexOf("## Current P1 findings"), doc.indexOf("### Evidence per P1"));
    const listed = new Set([...table.matchAll(/^\| `([A-Za-z0-9-]+)`/gm)].map((m) => m[1]));
    expect([...p1.map((f: any) => f.source_ids[0])].filter((id) => !listed.has(id)), "a P1 is missing from the table").toEqual([]);
    expect([...listed].filter((id) => !p1.some((f: any) => f.source_ids[0] === id)), "the table lists a non-P1").toEqual([]);
    // and each P1 gets its own evidence section with a stated Willow risk
    for (const f of p1) {
      expect(doc, `${f.source_ids[0]} needs an evidence section`).toContain(`#### \`${f.source_ids[0]}\``);
      expect(f.Willow_risk, `${f.source_ids[0]} must state its Willow risk`).toBeTruthy();
    }
    expect(doc).not.toMatch(/\*\*Willow risk:\*\*\s*\n/);
  });

  it("P2_DISPOSITION_REPORT.md carries a row for every P2 and P3", () => {
    const doc = read("P2_DISPOSITION_REPORT.md");
    for (const sev of ["P2", "P3"]) {
      const set = REG.findings.filter((f: any) => f.current_severity === sev);
      expect(doc, `${sev} heading count`).toContain(`## ${sev} (${set.length})`);
      for (const f of set) expect(doc, `${f.source_ids[0]} missing from the ${sev} table`).toContain(`| \`${f.source_ids[0]}\``);
    }
  });
});

describe("findings register: the PR train is derived from the register", () => {
  const trainRows = () =>
    read("FIRST_REMEDIATION_PR_TRAIN.md").split("\n").filter((l) => /^\| \*\*PR-\d+\*\*/.test(l))
      .map((l) => { const c = l.split("|").map((x) => x.trim());
        return { pr: c[1].replace(/\*/g, ""), findings: c[3], deps: c[5], migration: c[6], risk: c[7],
                 verification: c[8], rollback: c[9], gate: c[10] }; });

  it("pr_dependencies is derivable from canonical depends_on, not hand-maintained", () => {
    // Mutation-proved gap: a fabricated PR edge could be added to pr_dependencies and
    // to both documents consistently, and nothing tied any of it back to canonical data.
    const capabilityPR = (id: string) => {
      const f = findingBy(id);
      if (!f) return null;
      if (f.capability_pr) return f.capability_pr;
      const prs = f.required_prs ?? [];
      return prs.length ? prs[prs.length - 1] : null;
    };
    const derived: Record<string, Set<string>> = {};
    for (const pr of Object.keys(REG.pr_dependencies)) derived[pr] = new Set();
    for (const f of REG.findings) {
      for (const pr of f.required_prs ?? []) {
        const scoped = (f.depends_on_by_pr && f.depends_on_by_pr[pr]) ?? f.depends_on ?? [];
        for (const d of scoped) { const c = capabilityPR(d); if (c && c !== pr) derived[pr]?.add(c); }
      }
    }
    // The one hard edge that is a product fact rather than a data derivation, declared here.
    derived["PR-11"].add("PR-10 deployed"); derived["PR-10"].add("PR-01"); derived["PR-11"].add("PR-01");
    for (const [pr, deps] of Object.entries(REG.pr_dependencies) as [string, string[]][]) {
      expect([...deps].sort(), `${pr} dependencies must be derivable from canonical data`).toEqual([...derived[pr]].sort());
    }
  });

  it("each PR row names exactly the findings whose required_prs contain it", () => {
    const bad: string[] = [];
    for (const r of trainRows()) {
      const listed = new Set([...r.findings.matchAll(/`([A-Za-z0-9-]+)`/g)].map((m) => m[1]));
      const expected = new Set<string>(prMembers(r.pr).map((f: any) => String(f.source_ids[0])));
      for (const id of expected) if (!listed.has(id)) bad.push(`${r.pr}: ${id} is assigned to it but not listed`);
      for (const id of listed) if (!expected.has(id)) bad.push(`${r.pr}: lists ${id}, which is not assigned to it`);
    }
    expect(bad).toEqual([]);
  });

  it("no PR claims a finding the register lists as unscheduled", () => {
    const unscheduled = new Set(Object.keys(REG.unscheduled_findings));
    const claimed = new Set(REG.findings.flatMap((f: any) => (f.required_prs ?? []).length ? [f.source_ids[0]] : []));
    expect([...unscheduled].filter((id) => claimed.has(id)), "a finding cannot be both unscheduled and scheduled").toEqual([]);
  });

  it("each PR's gate effect equals the gates of the findings it carries", () => {
    const bad: string[] = [];
    for (const r of trainRows()) {
      const members = prMembers(r.pr);
      const gates = [...new Set(members.map((f: any) => f.launch_gate))];
      const stated = [...r.gate.matchAll(/(?:Closes|Contributes to) ([A-Z_0-9]+)/g)].map((m) => m[1]);
      if (JSON.stringify(stated.sort()) !== JSON.stringify(gates.sort())) {
        bad.push(`${r.pr}: states [${stated}] but carries findings gated [${gates}]`);
      }
      // "Closes" is only permitted when the PR covers every open finding at that gate
      for (const m of r.gate.matchAll(/Closes ([A-Z_0-9]+)/g)) {
        const open = REG.findings.filter((f: any) => f.launch_gate === m[1] && OPEN_STATUSES.includes(f.current_status));
        const covered = new Set(members.map((f: any) => f.canonical_id));
        const missed = open.filter((f: any) => !covered.has(f.canonical_id));
        if (missed.length) bad.push(`${r.pr}: claims to close ${m[1]} but misses ${missed.map((f: any) => f.source_ids[0])}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("each PR's production verification names every finding it carries", () => {
    const bad: string[] = [];
    for (const r of trainRows()) {
      for (const f of prMembers(r.pr)) {
        if (!r.verification.includes(f.source_ids[0])) bad.push(`${r.pr}: no acceptance criterion shown for ${f.source_ids[0]}`);
      }
      if (/…/.test(r.verification)) bad.push(`${r.pr}: an acceptance criterion is truncated`);
    }
    expect(bad).toEqual([]);
  });

  it("no PR is shown as low risk while a finding it carries records a high one", () => {
    const bad: string[] = [];
    for (const r of trainRows()) {
      const high = prMembers(r.pr).filter((f: any) => /^(HIGH|Live money|Live at Willow today)/i.test((f.Willow_risk ?? "").trim()));
      if (high.length && /^low\b/i.test(r.risk)) {
        bad.push(`${r.pr}: shown "${r.risk}" while ${high[0].source_ids[0]} records "${high[0].Willow_risk.slice(0, 60)}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the plan's PR-level graph and per-finding dependencies match the register", () => {
    // Mutation-proved gap: the plan carries a SECOND dependency table that no test read,
    // so the L18 app-first edge could be deleted there while the train still stated it.
    const plan = read("DEPENDENCY_REMEDIATION_PLAN.md");
    const bad: string[] = [];
    for (const [pr, deps] of Object.entries(REG.pr_dependencies) as [string, string[]][]) {
      const row = plan.split("\n").find((l) => l.startsWith(`| **${pr}** |`));
      if (!row) { bad.push(`${pr}: missing from the plan's PR graph`); continue; }
      const cell = row.split("|")[2].trim();
      const stated = cell === "—" ? [] : cell.split(",").map((x) => x.trim());
      if (JSON.stringify(stated.sort()) !== JSON.stringify([...deps].sort())) {
        bad.push(`${pr}: plan says [${stated}], register says [${deps}]`);
      }
    }
    for (const f of REG.findings) {
      if (!(f.depends_on ?? []).length || f.train === "NONE") continue;
      const row = plan.split("\n").find((l) => l.startsWith(`| **${f.train}**`));
      if (!row) continue;
      const depCell = row.split("|")[4] ?? "";
      const seg = depCell.split(";").find((s) => s.includes(`\`${f.source_ids[0]}\` →`));
      if (!seg) { bad.push(`${f.train}: no dependency entry for ${f.source_ids[0]}`); continue; }
      for (const d of f.depends_on) if (!seg.includes(d)) bad.push(`${f.source_ids[0]}: plan omits dependency ${d}`);
    }
    expect(bad).toEqual([]);
  });

  it("a finding's depends_on does not contradict a blocking phrase in its own prose", () => {
    // Pass 3 found four findings whose remediation_dependency named a blocker in prose
    // while depends_on was empty, and the acyclicity result depended on the omission.
    const IDS = REG.findings.map((f: any) => f.source_ids[0]);
    const bad: string[] = [];
    for (const f of REG.findings) {
      if (!OPEN_STATUSES.includes(f.current_status)) continue;
      const prose: string = f.remediation_dependency ?? "";
      // "the same X as Y" is co-scheduling, not a dependency; co_requisites cover genuinely
      // mutual pairs, which cannot be expressed as a direction without inventing one.
      const coreq: string[] = f.co_requisites ?? [];
      for (const m of prose.matchAll(/(hard-blocked on|blocked on|sequenced after|depends on)([^.]{0,160})/gi)) {
        if (/\bsame\b[^.]{0,60}\bas\b/i.test(m[0])) continue;
        for (const id of IDS) {
          if (id === f.source_ids[0] || !m[2].includes(id)) continue;
          if ((f.depends_on ?? []).includes(id)) continue;
          // an explicitly reconciled non-merge-order relationship is allowed, and must say so
          if ((f.operational_sequencing ?? "").includes(id)) continue;
          if (coreq.includes(id)) continue;
          if ((f.depends_on_by_pr_note ?? "").includes(id)) continue;
          if (prose.includes("DEPENDENCY RECONCILIATION")) continue;
          bad.push(`${f.source_ids[0]}: prose says "${m[1]} ... ${id}" but depends_on omits it`);
        }
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });
});

describe("findings register: the scope bar holds across every artifact", () => {
  // Mutation-proved gap: the sanitization guard read only the five Chloe CSV rows,
  // so a client name or treatment detail inserted into a canonical JSON finding,
  // or into any report, passed green.
  // These match CONTENT that must never appear, not descriptions of it. "no client name"
  // in an evidence field is a statement about a defect, not a customer name.
  const BANNED: [RegExp, string][] = [
    [/\b(see|attached|per|in) the screenshot\b/i, "a screenshot reference"],
    [/\.(png|jpg|jpeg|heic|gif)\b/i, "an image attachment"],
    [/\bpatient\b/i, "clinical-record language this product does not use"],
    [/\b(mrs?|ms|dr)\.\s+[A-Z][a-z]+/i, "a personal name"],
    [/\bclient (?:is |was |named) [A-Z][a-z]+/, "a named client"],
  ];
  it("no artifact carries a customer name, treatment content or a screenshot reference", () => {
    const corpus: [string, string][] = [
      ...MD_FILES.map((f) => [f, read(f)] as [string, string]),
      ["MASTER_FINDINGS_REGISTER.json", read("MASTER_FINDINGS_REGISTER.json")],
      ["MASTER_FINDINGS_REGISTER.csv", CSV],
    ];
    const bad: string[] = [];
    for (const [name, text] of corpus) {
      for (const [re, why] of BANNED) {
        const m = text.match(re);
        if (m) bad.push(`${name}: ${why}, "${m[0]}"`);
      }
    }
    expect(bad, "the audit records sanitized reports only, no names, treatment content or screenshots").toEqual([]);
  });

  it("the Chloe rows record that they are sanitized", () => {
    const rows = csvData.filter((r) => r[col("source_register")].includes("Chloe"));
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r[col("source_recorded_disposition")]).toMatch(/sanitized/i);
      expect(r[col("source_artifact_hash")]).toMatch(/no artifact stored/i);
    }
  });
});

describe("findings register: each acceptance criterion belongs to its own finding", () => {
  // Pass 3 found the L19a / L19b / L20 acceptance criteria rotated: L19b carried L20's
  // closure test, so PR-09 would have built the wrong fix and L19b would have stayed
  // open on evidence that never mentions it. Nothing detected the rotation.
  it("no two findings share an acceptance criterion", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const f of REG.findings) {
      const acc = (f.acceptance_evidence ?? "").trim();
      if (!acc || /NO ACCEPTANCE CRITERION/.test(acc)) continue;
      const prior = seen.get(acc);
      if (prior) dupes.push(`${f.source_ids[0]} shares its acceptance criterion with ${prior}`);
      else seen.set(acc, f.source_ids[0]);
    }
    expect(dupes, "a shared criterion means at least one finding cannot be closed on its own evidence").toEqual([]);
  });

  it("each open limitation's acceptance criterion names its own subject", () => {
    // The four limitations are close enough in subject to be rotated unnoticed, so
    // each is pinned to a token only its own remediation can satisfy.
    const SUBJECT: Record<string, RegExp> = {
      L18: /clinical tables/i,
      L19a: /TRUNCATE/i,
      L19b: /same[- ]?client|another CLIENT/i,
      L20: /service_role|session_replication_role/i,
    };
    const bad: string[] = [];
    for (const [id, re] of Object.entries(SUBJECT)) {
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      expect(f, `${id} must exist`).toBeDefined();
      if (!re.test(f.acceptance_evidence ?? "")) bad.push(`${id}: its acceptance criterion does not name its own subject`);
    }
    expect(bad).toEqual([]);
  });
});

describe("findings register: the retired direction cannot re-enter through acceptance criteria", () => {
  it("no scheduled finding's acceptance criterion asks for a retired capability", () => {
    // The July-27 criteria predate the retirement; three of them named finalized
    // states, a finalization/correction surface and a snapshot migration.
    const RETIRED = /finaliz|snapshot v2|snapshot migration|signed[- ]record/i;
    const bad: string[] = [];
    for (const f of REG.findings) {
      if (!(f.required_prs ?? []).length) continue;
      const acc: string = f.acceptance_evidence ?? "";
      if (!RETIRED.test(acc)) continue;
      // permitted only when the text explicitly restates it against this baseline
      if (/RESTATED for this baseline/.test(acc)) continue;
      bad.push(`${f.source_ids[0]}: acceptance criterion asks for a retired capability`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Pass-4 derivation guards.
//
// Pass 4 mutation-proved that derivation had been applied to the ROWS of the
// reports but not to their CELLS: a live P1 could be shown NOT_REACHABLE at
// POST_GA, a P2 could be shown PRODUCTION_VERIFIED, an entire canonical finding
// could be deleted and every artifact regenerated, and the pass-3 severity
// raises could be silently reverted, all with the suite green.
//
// It also proved the limit of this approach, which is stated in
// EVIDENCE_LIMITATIONS.md rather than left for a later pass to discover: these
// guards make STRUCTURED drift detectable. They cannot make prose self-verifying.
// ---------------------------------------------------------------------------

describe("findings register: the canonical set itself is pinned", () => {
  // Mutation-proved gap: F-OPS-004 could be deleted from the register, its CSV row
  // relabelled UNMAPPED_HISTORICAL, and every derived artifact regenerated, green.
  it("every non-historical source row maps to a canonical finding, and the mapped count is pinned", () => {
    const mapped = csvData.filter((r) => {
      const reg = r[col("source_register")];
      return reg.includes("2026-07-27") || reg.includes("Chloe") ||
             reg.includes("NEW-2026-07-30") || reg.includes("known-limitations");
    });
    expect(mapped.length, "48 July-27 + 5 Chloe + 2 discovered + 5 limitations").toBe(60);
    const orphans = mapped.filter((r) => {
      const cid = r[col("canonical_id")];
      return !cid || cid === "UNMAPPED_HISTORICAL" || !REG.findings.some((f: any) => f.canonical_id === cid);
    });
    expect(orphans.map((r) => r[col("source_id")]), "a mapped row lost its canonical finding").toEqual([]);
    expect(REG.findings.length, "the canonical set is 60 findings").toBe(60);
  });

  it("the severity and gate of every P1, and the Willow aggregate, are pinned", () => {
    // These are the judgements three review passes were spent establishing. A silent
    // revert of any of them is the single most damaging undetected edit possible.
    const EXPECTED: Record<string, [string, string]> = {
      // CHLOE-001's fix shipped in PR #485, so it carries no forward gate; it stays P1
      // as the record of what was fixed and is DEPLOYED_NOT_VERIFIED pending Chloe.
      "F-PAY-001": ["P1", "WILLOW_NOW"], "F-PRIV-001": ["P1", "WILLOW_NOW"],
      "F-COMP-001": ["P1", "WILLOW_NOW"], "F-CLIN-004": ["P1", "WILLOW_NOW"],
      "N-DOC-001": ["P1", "WILLOW_NOW"], "F-RET-001": ["P1", "WILLOW_NOW"],
      "CHLOE-001": ["P1", "NONE_SHIPPED"], "F-SEC-002": ["P1", "BEFORE_STUDIO_2"],
      "N-SEC-001": ["P1", "BEFORE_STUDIO_2"], "L18": ["P1", "BEFORE_STUDIO_2"],
      "F-DATA-001": ["P1", "BEFORE_STUDIO_2"], "F-IMPORT-001": ["P1", "BEFORE_STUDIO_2"],
    };
    const bad: string[] = [];
    for (const [id, [sev, gate]] of Object.entries(EXPECTED)) {
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      if (!f) { bad.push(`${id}: missing from the register`); continue; }
      if (f.current_severity !== sev) bad.push(`${id}: severity ${f.current_severity}, pinned ${sev}`);
      if (f.launch_gate !== gate) bad.push(`${id}: gate ${f.launch_gate}, pinned ${gate}`);
    }
    expect(bad).toEqual([]);
    const p1 = REG.findings.filter((f: any) => f.current_severity === "P1").map((f: any) => f.source_ids[0]);
    expect(p1.sort(), "the P1 set is exactly these twelve").toEqual(Object.keys(EXPECTED).sort());

    expect(REG.willow_practitioner_fact).toContain("2 practitioner");
    expect(REG.willow_practitioner_fact).toMatch(/1 ACTIVE owner/);
    expect(REG.willow_practitioner_fact).toMatch(/non-owner practitioners: 0/);
  });

  it("a discovered finding's original severity survives a later re-rating", () => {
    // Pass 3 raised L18 P2 -> P1 and the CSV's source_original_severity followed it,
    // destroying the record of what it was first rated.
    const ORIGINAL: Record<string, string> = { L18: "P2", L19a: "P2", L19b: "P2", L20: "P3", L21: "P3" };
    for (const [id, sev] of Object.entries(ORIGINAL)) {
      const row = csvData.find((r) => r[col("source_id")] === id);
      expect(row, `${id} row missing`).toBeDefined();
      expect(row![col("source_original_severity")], `${id} original severity was overwritten`).toBe(sev);
    }
    const l18 = REG.findings.find((f: any) => f.source_ids[0] === "L18");
    expect(l18.current_severity).toBe("P1");
  });
});

describe("findings register: report cells, not just report rows", () => {
  it("every cell of the P1 table matches the register", () => {
    const doc = read("CURRENT_P0_P1_REPORT.md");
    const table = doc.slice(doc.indexOf("| ID | Title"), doc.indexOf("### Evidence per P1"));
    const bad: string[] = [];
    for (const line of table.split("\n").filter((l) => /^\| `[A-Za-z0-9-]+` \|/.test(l))) {
      const c = line.split("|").map((x) => x.trim());
      const id = c[1].replace(/`/g, "");
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      if (!f) { bad.push(`${id}: not in the register`); continue; }
      if (c[3] !== f.current_exposure) bad.push(`${id}: exposure "${c[3]}" vs "${f.current_exposure}"`);
      if (c[4] !== f.launch_gate) bad.push(`${id}: gate "${c[4]}" vs "${f.launch_gate}"`);
      if (c[5] !== f.train) bad.push(`${id}: train "${c[5]}" vs "${f.train}"`);
      const prs = (f.required_prs ?? []).join(", ") || "—";
      if (c[6] !== prs) bad.push(`${id}: PR "${c[6]}" vs "${prs}"`);
    }
    expect(bad).toEqual([]);
  });

  it("each P1's evidence section carries its real evidence, not a stub", () => {
    // Mutation-proved gap: all 12 sections could be replaced with bare headings.
    const doc = read("CURRENT_P0_P1_REPORT.md");
    const bad: string[] = [];
    for (const f of REG.findings.filter((x: any) => x.current_severity === "P1")) {
      const id = f.source_ids[0];
      const start = doc.indexOf(`#### \`${id}\``);
      if (start < 0) { bad.push(`${id}: no evidence section`); continue; }
      const next = doc.indexOf("#### `", start + 6);
      const body = doc.slice(start, next < 0 ? doc.indexOf("## Demoted from P1", start) : next);
      if (body.length < 400) bad.push(`${id}: evidence section is a stub (${body.length} chars)`);
      for (const [label, field] of [["Source evidence", "exact_current_source"], ["Why P1", "rationale"],
                                    ["Willow risk", "Willow_risk"]] as [string, string][]) {
        const head = String(f[field] ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        if (!head) { bad.push(`${id}: ${field} is empty in the register`); continue; }
        if (!body.replace(/\s+/g, " ").includes(head)) bad.push(`${id}: ${label} does not match the register`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every cell of the P2/P3 disposition tables matches the register", () => {
    const doc = read("P2_DISPOSITION_REPORT.md");
    const validPR = new Set(Object.keys(REG.pr_dependencies));
    const bad: string[] = [];
    for (const line of doc.split("\n").filter((l) => /^\| `[A-Za-z0-9-]+` \|/.test(l))) {
      const c = line.split("|").map((x) => x.trim());
      const id = c[1].replace(/`/g, "");
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      if (!f) { bad.push(`${id}: not in the register`); continue; }
      if (c[3] !== f.current_status) bad.push(`${id}: status "${c[3]}" vs "${f.current_status}"`);
      if (c[4] !== f.launch_gate) bad.push(`${id}: gate "${c[4]}" vs "${f.launch_gate}"`);
      if (c[5] !== f.train) bad.push(`${id}: train "${c[5]}" vs "${f.train}"`);
      const prCell = c[6] ?? "";
      for (const m of prCell.matchAll(/PR-\d+/g)) {
        if (!validPR.has(m[0])) bad.push(`${id}: names ${m[0]}, which is not a PR in the train`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("the reconciliation report's counts are all derived from the register", () => {
    const doc = read("RECONCILIATION_REPORT.md");
    const n = (p: (f: any) => boolean) => REG.findings.filter(p).length;
    const sev = (s: string) => REG.findings.filter((f: any) => f.current_severity === s);
    // §A severity rows
    for (const s of ["P0", "P1", "P2", "P3"]) {
      const row = doc.split("\n").find((l) => l.startsWith(`| ${s} |`));
      if (!row) { expect(sev(s).length, `${s} has findings but no §A row`).toBe(0); continue; }
      const c = row.split("|").map((x) => x.trim());
      expect(Number(c[3]), `${s} OPEN`).toBe(n((f) => f.current_severity === s && f.current_status === "OPEN"));
      expect(Number(c[4]), `${s} partial`).toBe(n((f) => f.current_severity === s && f.current_status === "PARTIALLY_FIXED"));
      expect(Number(c[9]), `${s} evidence-limited`).toBe(n((f) => f.current_severity === s && f.current_status === "EVIDENCE_LIMITATION"));
    }
    // canonical/source totals and the P1 heading
    expect(doc).toContain(`**Canonical total: ${REG.counts.canonical_total}**`);
    expect(doc).toContain(`source rows in the CSV: **${REG.counts.source_rows_in_csv_total}**`);
    expect(doc).toContain(`## C. Current P1s (${sev("P1").length})`);
    // §F limitation rows
    const sectionF = doc.slice(doc.indexOf("## F. Open limitations"), doc.indexOf("## G."));
    for (const id of ["L18", "L19a", "L19b", "L20", "L21"]) {
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      const row = sectionF.split("\n").find((l) => l.startsWith(`| \`${id}\` |`));
      expect(row, `${id} missing from §F`).toBeDefined();
      const c = row!.split("|").map((x) => x.trim());
      expect(c[3], `${id} §F severity`).toBe(f.current_severity);
      expect(c[4], `${id} §F status`).toBe(f.current_status);
      expect(c[6], `${id} §F gate`).toBe(f.launch_gate);
      expect(c[7], `${id} §F train`).toBe(f.train);
    }
    // §I must not restate a severity mix the register contradicts
    const limSev: Record<string, number> = {};
    for (const id of ["L18", "L19a", "L19b", "L20", "L21"]) {
      const f = REG.findings.find((x: any) => x.source_ids[0] === id);
      limSev[f.current_severity] = (limSev[f.current_severity] ?? 0) + 1;
    }
    const expectedMix = ["P1", "P2", "P3"].filter((s) => limSev[s]).map((s) => `${s}×${limSev[s]}`).join(", ");
    expect(doc, "§I's limitation severity mix must match the register").toContain(expectedMix);
  });
});

describe("findings register: the closure register cannot be hollowed out", () => {
  it("every disposition row carries a defect, a correction and a verification", () => {
    // Mutation-proved gap: all 91 rows could be blanked, and every disposition
    // flipped, with the suite green.
    const rows = read("REVIEW_CLOSURE_REGISTER.md").split("\n")
      .filter((l) => /^\| \d+ \| P[123] \| \*\*/.test(l))
      .map((l) => l.split("|").map((c) => c.trim()));
    expect(rows.length).toBe(114);
    const bad: string[] = [];
    for (const c of rows) {
      const n = c[1];
      const isDupe = /DUPLICATE_OF_REVIEW_ITEM/.test(c[3]);
      const cells = c.slice(4, -1).filter(Boolean);
      if (cells.length < (isDupe ? 2 : 3)) bad.push(`item ${n}: evidence columns are empty`);
      const correction = cells[cells.length - 2] ?? "";
      if (!isDupe && correction.length < 40) bad.push(`item ${n}: correction is not stated`);
    }
    expect(bad).toEqual([]);
    // the disposition mix is pinned so a wholesale flip is visible
    const counts: Record<string, number> = {};
    for (const c of rows) {
      const key = c[3].replace(/\*/g, "").replace(/DUPLICATE_OF_REVIEW_ITEM_\d+/, "DUPLICATE");
      counts[key] = (counts[key] ?? 0) + 1;
    }
    expect(counts["DUPLICATE"]).toBe(5);
    expect(counts["REOPENED_IN_PASS_2 → CORRECTED_AND_VERIFIED"]).toBe(12);
  });

  it("the pass-1 record's status column matches the closure register item by item", () => {
    // Mutation-proved gap: all 33 status cells could be rewritten to "NOT FIXED"
    // (and the manifest hash refreshed) with the suite green. The previous guard
    // was a single grep for one literal phrase.
    const closure = read("REVIEW_CLOSURE_REGISTER.md");
    const pass1Table = closure.slice(closure.indexOf("## Pass 1 —"), closure.indexOf("## Pass 2 —"));
    const dispositions = new Map<string, string>();
    for (const l of pass1Table.split("\n")) {
      const m = l.match(/^\| (\d+) \| P[123] \| \*\*([^*]+)\*\*/);
      if (m) dispositions.set(m[1], m[2].trim());
    }
    expect(dispositions.size).toBe(33);

    const record = read("INDEPENDENT_REVIEW_FINDINGS.md");
    const bad: string[] = [];
    for (const l of record.split("\n")) {
      const m = l.match(/^\| (\d+) \| /);
      if (!m) continue;
      const want = dispositions.get(m[1]);
      if (!want) { bad.push(`item ${m[1]}: no disposition in the closure register`); continue; }
      const status = l.split("|").map((c) => c.trim()).filter(Boolean).pop() ?? "";
      if (status.replace(/\*/g, "").trim() !== want) {
        bad.push(`item ${m[1]}: record says "${status.slice(0, 40)}", register says "${want}"`);
      }
    }
    expect(bad, "the frozen pass-1 record must not contradict the authoritative register").toEqual([]);
    expect([...dispositions.keys()].length).toBe(33);
  });
});

describe("findings register: remaining artifact integrity", () => {
  it("the manifest and the JSON carry the same baseline as the reports", () => {
    const manifest = read("AUDIT_INPUT_MANIFEST.json");
    for (const text of [manifest, read("MASTER_FINDINGS_REGISTER.json")]) {
      for (const m of text.matchAll(/\b[0-9a-f]{40}\b/g)) {
        if (m[0] === PROD_SHA) continue;
        // review heads and the July-27 audit's own ZIP comment are named elsewhere
        if (["1468d051b5ed5bbcf2d8909b23bf4e9c1b6aeee0", "7566a9c82f5ca8eb0ba86bac90b8c5ca2eac67ef",
             "0e5357404eab654769dd9765ca46105f96050d7f", "2f9b9e9dda6108f48d6255f674a8b49832d2f02d",
             "c64366c9ba4130283932bbe21e32bf2ed62c4975", // the audit verification head
             "058b8bcbd1a80d6aa89c47f9357e1964328f220d", // the July-27 audit's own ZIP comment
             "d579faea06699baf72dcc4098bc515f646506d89", // git tree of the production commit
            ].includes(m[0])) continue;
        throw new Error(`unexpected 40-hex SHA in a machine-readable artifact: ${m[0]}`);
      }
    }
    expect(JSON.parse(manifest).production_sha).toBe(PROD_SHA);
  });

  it("no source_* column can be renamed away", () => {
    // Column identity is what makes "no source column is dropped" checkable.
    const REQUIRED = [
      "source_register", "source_id", "source_title", "source_original_severity", "source_date",
      "source_baseline_sha", "source_recorded_disposition", "source_evidence", "source_acceptance_criteria",
      "source_recommended_fix", "source_production_evidence", "source_artifact_hash",
      "source_code_status", "source_migration_status", "source_deployment_status", "source_enabled_status",
      "source_exercised_status", "source_rollback", "source_willow_impact", "source_classification_rationale",
      "source_category", "source_provider_impact", "source_data_migration_required",
      "source_risk_at_stake", "source_business_impact", "source_confidence", "source_existing_controls",
      "source_why_controls_insufficient", "source_required_regression_tests", "source_reproduction",
      "source_classification", "source_domain", "source_exact_source_location", "source_confidence_rating",
      "source_exploitability", "source_affected_scope", "source_current_exposure", "source_remediation_effort",
      "source_affected_personas", "source_affected_tenants", "source_affected_workflows",
      "source_affected_feature", "source_affected_launch_scenarios", "source_affected_users_data",
    ];
    for (const c of REQUIRED) expect(csvHeader, `${c} must exist`).toContain(c);
  });

  it("no PR row is shown without a Willow risk", () => {
    const rows = read("FIRST_REMEDIATION_PR_TRAIN.md").split("\n")
      .filter((l) => /^\| \*\*PR-\d+\*\*/.test(l)).map((l) => l.split("|").map((c) => c.trim()));
    const bad = rows.filter((c) => !c[7] || c[7].length < 4).map((c) => c[1]);
    expect(bad, "every PR must state a Willow risk").toEqual([]);
  });

  it("the audit's provenance statements name the current pass", () => {
    expect(read("RECONCILIATION_REPORT.md")).not.toMatch(/Corrected pass 2\b/);
    const manifest = JSON.parse(read("AUDIT_INPUT_MANIFEST.json"));
    expect(String(manifest.pass)).toMatch(/accepted 2026-07-31/);
    expect(manifest.production_sha).toBe(PROD_SHA);
    expect(manifest.audit_verification_sha).toBe(AUDIT_SHA);
  });
});
