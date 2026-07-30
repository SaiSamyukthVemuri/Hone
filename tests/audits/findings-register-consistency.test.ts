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
    expect(csvData.length).toBe(123); // 122 source rows + 1 discovered in this run
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

  it("JSON counts block matches the findings array", () => {
    expect(REG.counts.canonical_total).toBe(REG.findings.length);
    for (const [k, v] of Object.entries(REG.counts.by_severity)) expect(sev(k)).toBe(v);
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
