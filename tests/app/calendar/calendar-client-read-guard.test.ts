import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// HON-58: the guard BINDS to what the calendar reads, it does not spell-check.
//
// It scans, as text, (a) every file under app/(app)/calendar and (b) every helper those files import BY NAME from lib/**
// (the exported function or constant's own body, with the string constants it references substituted in). In that text it
// checks every read of the clients table, however it is spelled:
//   * `.from("clients")` followed by `.select(ARG)`: ARG must be a string literal after substitution, never a variable or a
//     call whose value this test cannot see, never empty, never containing `*`;
//   * every `clients(...)` / `clients!fk(...)` embed: the only `${...}` allowed inside is `preferredNameColumn(<name>)`; any
//     other placeholder (a shared string or helper spliced into the select) fails, because its value cannot be bound here;
//   * no `*`, no legal identity table or `legal_*` column inside any of them.
// And in every scanned file: no `client_legal_identities`, no `legal_given/middle/family_name`, no import of the legal-identity reader.
// Bound (stated, not hidden): a helper's own callees are not followed; the loader the calendar page uses is covered at run time by
// tests/lib/booking/calendar-display-name.test.ts, which captures the real select string.

const ROOT = process.cwd();
const CAL_DIR = join(ROOT, "app/(app)/calendar");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
function resolveImport(spec: string, from: string): string | null {
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(base + ext) && statSync(base + ext).isFile()) return base + ext;
  }
  return null;
}
function balanced(src: string, open: number, o = "(", c = ")"): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return src.slice(open + 1, i);
  }
  return null;
}
/** The text of `export [async] function NAME` or `export const NAME`, or null. */
function symbolText(src: string, name: string): string | null {
  const m = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s+${name}\\b|const\\s+${name}\\b)`).exec(src);
  if (!m) return null;
  const brace = src.indexOf("{", m.index);
  const semi = src.indexOf(";", m.index);
  if (m[0].includes("const") && (semi !== -1 && (brace === -1 || semi < brace))) return src.slice(m.index, semi + 1);
  return brace === -1 ? null : src.slice(m.index, brace) + (balanced(src, brace, "{", "}") ?? "");
}
/** Replace identifiers that name a string constant in `module` with that constant's literal text. */
function substituteConstants(text: string, module: string): string {
  return text.replace(/\.select\(\s*([A-Z][A-Z0-9_]+)\s*\)/g, (whole, id: string) => {
    const m = new RegExp(`const\\s+${id}\\s*=\\s*(["\`])([\\s\\S]*?)\\1`).exec(module);
    return m ? `.select("${m[2]}")` : whole;
  });
}

type Finding = string;
export function checkClientReads(text: string, label: string): Finding[] {
  const out: Finding[] = [];
  // Reads through .from("clients").
  for (const m of text.matchAll(/\.from\(\s*["'`]clients["'`]\s*\)/g)) {
    const tail = text.slice(m.index! + m[0].length);
    const sel = /\.select\(/.exec(tail);
    // The chain ends at the first `;`: a select after that belongs to another statement.
    const stop = tail.indexOf(";");
    if (!sel || (stop !== -1 && sel.index > stop)) continue; // a write with no returning select, or no read at all
    const arg = balanced(tail, sel.index + ".select".length)?.trim() ?? "";
    if (arg === "") out.push(`${label}: .from("clients").select() with no column list`);
    else if (!/^(["'`])[\s\S]*\1$/.test(arg)) out.push(`${label}: .from("clients").select(${arg.slice(0, 40)}) is not a literal this guard can read`);
    else if (arg.slice(1, -1).includes("*")) out.push(`${label}: .from("clients").select reads *`);
    else if (/\$\{/.test(arg)) {
      const rest = arg.replace(/\$\{\s*preferredNameColumn\([A-Za-z_][A-Za-z0-9_]*\)\s*\}/g, "");
      if (/\$\{/.test(rest)) out.push(`${label}: .from("clients").select splices a value this guard cannot read`);
    }
  }
  // Embeds: clients(...) and clients!fk(...).
  for (const m of text.matchAll(/\bclients(?:![A-Za-z0-9_]+)?\(/g)) {
    const open = m.index! + m[0].length - 1;
    const inner = balanced(text, open) ?? "";
    // A `clients(` that is prose in a comment is not an embed: embeds list columns, so require a column-ish first token.
    if (!/^\s*[*$A-Za-z_]/.test(inner)) continue;
    const line = text.slice(text.lastIndexOf("\n", m.index!) + 1, m.index!);
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    if (inner.includes("*")) out.push(`${label}: clients(...) embed reads *`);
    if (/legal/i.test(inner)) out.push(`${label}: clients(...) embed reaches legal identity`);
    const rest = inner.replace(/\$\{\s*preferredNameColumn\([A-Za-z_][A-Za-z0-9_]*\)\s*\}/g, "");
    if (/\$\{/.test(rest)) out.push(`${label}: clients(...) embed splices a value this guard cannot read`);
  }
  if (/client_legal_identities|legal_(?:given|middle|family)_name|LEGAL_IDENTITY_COLUMNS|@\/lib\/clients\/legal-identity/.test(text)) {
    out.push(`${label}: touches the legal identity table, a legal_* column or its reader`);
  }
  return out;
}

function scannedTexts(): Array<{ label: string; text: string }> {
  const files = walk(CAL_DIR);
  const texts: Array<{ label: string; text: string }> = [];
  const seenSymbols = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    texts.push({ label: f.replace(ROOT + "/", ""), text: src });
    for (const imp of src.matchAll(/import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["']([^"']+)["']/g)) {
      if (!/^@\/lib\//.test(imp[2])) continue;
      const target = resolveImport(imp[2], f);
      if (!target) continue;
      const mod = readFileSync(target, "utf8");
      for (const raw of imp[1].split(",")) {
        const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        const key = `${target}#${name}`;
        if (seenSymbols.has(key)) continue;
        seenSymbols.add(key);
        const body = symbolText(mod, name);
        if (body) texts.push({ label: `${target.replace(ROOT + "/", "")}#${name}`, text: substituteConstants(body, mod) });
      }
    }
  }
  return texts;
}

describe("the calendar's reads of the clients table bind", () => {
  const texts = scannedTexts();

  it("scans the calendar files AND the helpers they import by name, not an empty set", () => {
    const labels = texts.map((t) => t.label);
    expect(labels.some((l) => l.startsWith("app/(app)/calendar/actions.ts"))).toBe(true);
    expect(labels.some((l) => l.startsWith("app/(app)/calendar/[id]/page.tsx"))).toBe(true);
    expect(labels.some((l) => l === "lib/booking/queries.ts#getAppointmentsForRange"), "the loader the grid uses").toBe(true);
    expect(labels.some((l) => l === "lib/supabase/queries.ts#getClientsForStudio"), "the quick-book picker's loader").toBe(true);
  });

  it("no scanned read of clients selects *, splices an unreadable value, or reaches legal identity", () => {
    const findings = texts.flatMap((t) => checkClientReads(t.text, t.label));
    expect(findings).toEqual([]);
  });

  it("actually finds the reads it is meant to police (the guard is not vacuous)", () => {
    const joined = texts.map((t) => t.text).join("\n");
    expect((joined.match(/\.from\(\s*"clients"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((joined.match(/\bclients\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("the guard's own negative controls: each of these spellings must be caught", () => {
  const bad: Array<[string, string]> = [
    ["star select", `supabase.from("clients").select("*").eq("id", 1)`],
    ["empty select", `supabase.from("clients").select().eq("id", 1)`],
    ["variable select", `supabase.from("clients").select(cols).eq("id", 1)`],
    ["call select", `supabase.from("clients").select(buildColumns()).eq("id", 1)`],
    ["spliced helper in a select", "supabase.from(\"clients\").select(`id, ${sharedColumns}`)"],
    ["star embed", "supabase.from(\"appointments\").select(`id, client:clients(*)`)"],
    ["spliced embed", "supabase.from(\"appointments\").select(`id, client:clients(${CLIENT_COLUMNS})`)"],
    ["legal embed", "supabase.from(\"appointments\").select(`id, client:clients(id, client_legal_identities(legal_given_name))`)"],
    ["legal column", `supabase.from("clients").select("id, legal_family_name")`],
    ["legal reader import", `import { readLegalIdentity } from "@/lib/clients/legal-identity";`],
    ["fk-hinted star embed", "supabase.from(\"appointments\").select(`id, client:clients!appointments_client_fk(*)`)"],
  ];
  for (const [name, snippet] of bad) {
    it(`flags: ${name}`, () => expect(checkClientReads(snippet, "synthetic")).not.toEqual([]));
  }
  const good: Array<[string, string]> = [
    ["named columns", `supabase.from("clients").select("id, name, email")`],
    ["preferred helper", "supabase.from(\"appointments\").select(`id, client:clients(id, ${preferredNameColumn(includePreferred)}name)`)"],
    ["insert without a read", `supabase.from("clients").insert({ name }); return { ok: true };`],
  ];
  for (const [name, snippet] of good) {
    it(`accepts: ${name}`, () => expect(checkClientReads(snippet, "synthetic")).toEqual([]));
  }
  it("a constant that hides a star is caught after substitution", () => {
    const mod = `const COLS = "id, *";\nexport async function load() { return supabase.from("clients").select(COLS); }`;
    const body = substituteConstants(symbolText(mod, "load")!, mod);
    expect(checkClientReads(body, "synthetic")).not.toEqual([]);
  });
});
