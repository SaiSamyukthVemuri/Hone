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
      "BEFORE_PUBLIC_SELF_SERVICE","BEFORE_50_STUDIOS","POST_GA","NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION"];
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

  it("the dependency graph is acyclic and nothing precedes its dependency", () => {
    const byId: Record<string, any> = {};
    REG.findings.forEach((f: any) => { byId[f.source_ids[0]] = f; });
    const walk = (id: string, seen: string[]): string[] | null => {
      if (seen.includes(id)) return [...seen, id];
      const f = byId[id]; if (!f) return null;
      for (const d of f.depends_on || []) { const r = walk(d, [...seen, id]); if (r) return r; }
      return null;
    };
    const cycles = REG.findings.map((f: any) => walk(f.source_ids[0], [])).filter(Boolean);
    expect(cycles.slice(0, 1), "dependency cycle detected").toEqual([]);
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

  it("one authoritative Willow practitioner fact is stated and used", () => {
    expect(REG.willow_practitioner_fact).toMatch(/1 ACTIVE owner/);
    expect(REG.willow_practitioner_fact).toMatch(/Active non-owner practitioners: 0/);
    const rep = readFileSync(join(DIR, "CURRENT_P0_P1_REPORT.md"), "utf8");
    expect(rep).toContain("1 ACTIVE owner");
    expect(rep, "no contradictory 'unknown practitioner count' claim").not.toMatch(/practitioner count is unknown/i);
  });

  it("every one of the 33 review items has a final non-open disposition", () => {
    const closure = readFileSync(join(DIR, "REVIEW_CLOSURE_REGISTER.md"), "utf8");
    const rows = [...closure.matchAll(/^\| (\d+) \| (P[0-3]) \| \*\*([A-Z_0-9]+)\*\*/gm)];
    expect(rows.length, "all 33 review items must be dispositioned").toBe(33);
    const seen = new Set<string>();
    for (const r of rows) {
      const d = r[3];
      const ok = d === "CORRECTED_AND_VERIFIED" || d === "REFUTED_WITH_EVIDENCE" ||
        /^DUPLICATE_OF_REVIEW_ITEM_\d+$/.test(d);
      expect(ok, `item ${r[1]} has a non-final disposition: ${d}`).toBe(true);
      seen.add(r[1]);
      // a duplicate must point at a real item number, and not at itself
      const dup = d.match(/^DUPLICATE_OF_REVIEW_ITEM_(\d+)$/);
      if (dup) {
        const target = Number(dup[1]);
        expect(target, `item ${r[1]} points at itself`).not.toBe(Number(r[1]));
        expect(target >= 1 && target <= 33, `item ${r[1]} points outside 1-33`).toBe(true);
      }
    }
    expect(seen.size, "review item numbers must be unique 1..33").toBe(33);
    // Scope to the numbered table rows: the prose header legitimately says
    // "No item is OPEN, deferred, or partially corrected", which a whole-file
    // scan would flag as the very thing it denies.
    const tableRows = closure.split("\n").filter((l) => /^\| \d+ \|/.test(l));
    expect(tableRows.length).toBe(33);
    for (const l of tableRows) {
      expect(l, `a review row still reads open/deferred: ${l.slice(0, 90)}`)
        .not.toMatch(/\*\*OPEN\*\*|\bdeferred\b|\bpartially corrected\b/i);
    }
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
