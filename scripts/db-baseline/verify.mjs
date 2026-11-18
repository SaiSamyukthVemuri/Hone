// Pure checks over fingerprint lines. No database, no docker: the restore script feeds it
// what it measured, and the tests feed it fixtures.
import { createHash } from "node:crypto";

export const CATEGORIES = ["migrations", "catalog", "grants", "extensions", "outside", "data", "authusers"];

/** Parses "category:line" output into { category: sortedLines[] }. */
export function parseFingerprint(text) {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line) continue;
    const i = line.indexOf(":");
    const cat = line.slice(0, i);
    if (!(cat in out)) throw new Error(`unrecognised fingerprint line: ${line.slice(0, 80)}`);
    out[cat].push(line.slice(i + 1));
  }
  for (const c of CATEGORIES) out[c].sort();
  return out;
}

export const summarise = (fp) =>
  Object.fromEntries(CATEGORIES.map((c) => [c, { n: fp[c].length, md5: createHash("md5").update(fp[c].join("\n")).digest("hex") }]));

/** pg_get_constraintdef parenthesises a flat AND differently after a dump and restore. */
const flat = (s) => s.replace(/[()\s]/g, "");

const diff = (a, b) => {
  const sb = new Set(b);
  const sa = new Set(a);
  return { missing: a.filter((x) => !sb.has(x)), extra: b.filter((x) => !sa.has(x)) };
};

/**
 * The restored database against the CHAIN it stands in for. Returns a list of problems;
 * empty means equivalent. Grants are compared EXACTLY, and any grant the restored side has
 * that the chain does not is reported as EXTRA GRANT, because that is the failure that
 * matters: a restore must never give an object more access than the migration chain did.
 */
export function chainProblems(chain, restored) {
  const problems = [];
  for (const cat of CATEGORIES) {
    if (cat === "catalog") {
      const a = chain.catalog.map(flat).sort();
      const b = restored.catalog.map(flat).sort();
      const d = diff(a, b);
      for (const x of d.missing) problems.push(`catalog: missing after restore: ${x.slice(0, 120)}`);
      for (const x of d.extra) problems.push(`catalog: unexpected after restore: ${x.slice(0, 120)}`);
      continue;
    }
    const d = diff(chain[cat], restored[cat]);
    if (cat === "grants") {
      for (const x of d.extra) problems.push(`EXTRA GRANT after restore (the chain does not have it): ${x.slice(0, 160)}`);
      for (const x of d.missing) problems.push(`grant missing after restore: ${x.slice(0, 160)}`);
    } else {
      for (const x of d.missing) problems.push(`${cat}: missing after restore: ${x.slice(0, 120)}`);
      for (const x of d.extra) problems.push(`${cat}: unexpected after restore: ${x.slice(0, 120)}`);
    }
  }
  return problems;
}

/** The restored database against the verification restore recorded when the entry was sealed. */
export function drift(sealed, restored) {
  const problems = [];
  for (const cat of CATEGORIES) {
    const d = diff(sealed[cat], restored[cat]);
    for (const x of d.missing) problems.push(`${cat}: differs from the sealed verification restore (missing): ${x.slice(0, 120)}`);
    for (const x of d.extra) problems.push(`${cat}: differs from the sealed verification restore (extra): ${x.slice(0, 120)}`);
  }
  return problems;
}
