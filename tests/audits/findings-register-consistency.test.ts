import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Consistency guards for the 2026-07-30 exact-production findings reconciliation.
// These prove the register is internally coherent and that a retired product
// direction cannot creep back in via a scheduled remediation item.

const DIR = join(process.cwd(), "docs/audits/2026-07-30");
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const REG = JSON.parse(read("MASTER_FINDINGS_REGISTER.json"));
const CSV = read("MASTER_FINDINGS_REGISTER.csv");
const PROD_SHA = "c64366c9ba4130283932bbe21e32bf2ed62c4975";

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

describe("findings register — CSV structural integrity", () => {
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

describe("findings register — source preservation", () => {
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

describe("findings register — classification integrity", () => {
  const OPEN_ISH = ["OPEN", "PARTIALLY_FIXED"];

  it("every OPEN/PARTIALLY_FIXED P0 or P1 has a remediation wave", () => {
    const offenders = REG.findings.filter(
      (f: any) => ["P0", "P1"].includes(f.current_severity) && OPEN_ISH.includes(f.current_status)
                  && (!f.remediation_wave || f.remediation_wave === "NONE"));
    expect(offenders.map((f: any) => f.canonical_id)).toEqual([]);
  });

  it("every finding has a launch gate", () => {
    const GATES = ["WILLOW_NOW","BEFORE_STUDIO_2","BEFORE_THREE_STUDIOS","BEFORE_TEN_STUDIOS",
      "BEFORE_PUBLIC_SELF_SERVICE","BEFORE_50_STUDIOS","POST_GA","NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION","NONE_CLOSED"];
    for (const f of REG.findings) expect(GATES, `${f.canonical_id} gate=${f.launch_gate}`).toContain(f.launch_gate);
  });

  it("no RETIRED or SUPERSEDED finding is scheduled for implementation", () => {
    const bad = REG.findings.filter((f: any) =>
      ["RETIRED", "SUPERSEDED_BY_PRODUCT_DECISION"].includes(f.current_status) &&
      f.remediation_wave && f.remediation_wave !== "NONE");
    expect(bad.map((f: any) => `${f.canonical_id}:${f.remediation_wave}`)).toEqual([]);
  });

  it("every finding records the exact production SHA it was verified against", () => {
    for (const f of REG.findings) expect(f.last_verified_sha, f.canonical_id).toBe(PROD_SHA);
    expect(REG.production_sha).toBe(PROD_SHA);
    expect(REG.hosted_migration_max).toBe("0160");
  });
});

describe("findings register — the retired product direction cannot return", () => {
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

describe("findings register — counts agree across Markdown, CSV and JSON", () => {
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
describe("findings register — source preservation is diffed, not asserted", () => {
  // Pass 2 found five source columns dropped for every historical row — July-18
  // willow_impact and rationale on all 34, July-10 business impact / risk-at-stake /
  // confidence on all 40 — while the map claimed full carry-through. The July-18
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
    // `Required regression tests` under source_test_limitations — inverting both.
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

describe("findings register — source preservation is real, not claimed", () => {
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

describe("findings register — trains, PRs and gates", () => {
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
  // ordering edge — including the L18 app-first constraint — was unguarded. This
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

  it("status and launch gate are compatible", () => {
    const CLOSED = ["PRODUCTION_VERIFIED", "RETIRED", "SUPERSEDED_BY_PRODUCT_DECISION", "NOT_A_LAUNCH_REQUIREMENT", "FALSE_POSITIVE"];
    const bad = REG.findings.filter((f: any) => CLOSED.includes(f.current_status) && f.train !== "NONE");
    expect(bad.map((f: any) => `${f.canonical_id}:${f.current_status}:${f.train}`)).toEqual([]);
  });
});

describe("findings register — pass-2 corrections hold", () => {
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

    const STALE = /could not (determine|establish)[^.]{0,120}practitioner/i;
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
    expect(pay.launch_gate).toBe("BEFORE_STUDIO_2");
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

describe("findings register — pass-2 review corrections hold", () => {
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
    // CHLOE-002 is the only EVIDENCE_LIMITATION row; it must not inflate a WILLOW_NOW count.
    const el = REG.findings.filter((f: any) => f.current_status === "EVIDENCE_LIMITATION");
    expect(el.map((f: any) => f.source_ids[0])).toEqual(["CHLOE-002"]);
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
    expect(exec.exact_hosted_evidence).toContain(PROD_SHA);
    const ev = read("EVIDENCE_LIMITATIONS.md");
    expect(ev).toContain("30572200532");
    // the audit branch's own run must not be presented as production evidence
    expect(ev).not.toContain("30577864921");
  });

  it("no finding still cites the Upstash configuration question that F-OPS-001 closed", () => {
    const stale = REG.findings.filter((f: any) =>
      /rate-limit env vars are actually configured/i.test(f.missing_evidence ?? ""),
    );
    expect(stale.map((f: any) => f.source_ids[0])).toEqual([]);
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

  it("every review item in both passes has a final disposition and no artifact contradicts it", () => {
    const closure = read("REVIEW_CLOSURE_REGISTER.md");
    // Both tables carry the disposition in a **bolded** cell; read that cell alone.
    // Scanning the whole row matches quoted prose (e.g. a correction that says an item
    // "was open"), which is exactly the kind of false trigger this suite has to avoid.
    const rows = closure
      .split("\n")
      .filter((l) => /^\| \d+ \| P[123] \| \*\*/.test(l))
      .map((l) => ({ n: l.split("|")[1].trim(), disposition: l.split("|")[3].trim() }));
    expect(rows.length, "33 pass-1 items + 25 pass-2 items").toBe(58);
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
