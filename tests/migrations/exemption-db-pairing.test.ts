import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// G6(a) (REVIEW-PROCESS-GAPS-20261028): every test-only exemption list is paired
// with a DB test that exercises the REAL function.
//
// THE CLASS. A migration source-contract test reads SQL text. When it also holds
// an exemption list ("these tables are not checked", "these objects are not
// money"), it proves only what the list SAYS. Whether the function really
// behaves that way is a database fact. The hon-60 `NOT_PAYMENT_MONEY` list was
// exactly that: a text-level exemption that hid from the test the refusal the
// frozen 0214 initializer would issue against every studio (found in review,
// removed in f9d455570, and then proved by running the real initializer).
//
// THE RULE. A declaration in tests/migrations/**/*.test.ts whose name says it is
// an exemption must be preceded, within the same file, by a marker:
//
//   // exemption-db-pair: <tests/db/....db.test.ts> | <function> | <entry>[, <entry>...]
//
// and the named DB test must exist, be a `.db.test.ts` file under tests/db, name
// the real function, and name EVERY entry the exemption lists (so each entry,
// not just the list, is exercised against the database). The DB test's own
// outcome is its CI lane's business; this guard only keeps the pairing from
// being skipped.

const ROOT = path.resolve(__dirname, "../..");

/** A declaration that is an exemption by NAME. */
const EXEMPTION_DECL =
  /^\s*(?:export\s+)?(?:const|let|var)\s+((?=[A-Z0-9_]*(?:EXEMPT|WAIVE|NOT_[A-Z]+_(?:MONEY|PAYMENT|CLINICAL)))[A-Z][A-Z0-9_]*)\b/gm;
/** Mutating methods: any of these on the declared name extends the list after its initializer. */
const MUTATORS = ["add", "push", "concat", "unshift", "splice"] as const;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-token match, so a longer identifier or a prefix cannot satisfy the check (Insurance E2). */
const names = (haystack: string, token: string) => new RegExp(`(?<![\\w$])${escapeRe(token)}(?![\\w$])`).test(haystack);
const MARKER = /^\s*\/\/\s*exemption-db-pair:\s*(.+)$/gm;

export type Source = { path: string; text: string };

/**
 * What a declaration ACTUALLY lists, read from its initializer (Codex, #1213
 * 4401356805: a marker alone can go stale when an entry is appended; Insurance
 * PEER-1213-P2 E1: a list read only in part can pass). Scans from the `=` to the
 * end of the statement, skipping comments, and returns every string literal plus
 * `foreign`: any other text in the initializer. Only brackets, parentheses,
 * commas, comments, `new Set`, an optional `<...>` generic and `as const` are
 * permitted around the literals. A spread, an identifier element, `.concat`,
 * `.add` or `.push` (including a chained call on the next line) leaves foreign
 * text, which the caller reports because it can add entries the guard cannot
 * see. Returns null when the initializer cannot be read at all (no `=`, no
 * string entry, or an unterminated block comment).
 */
export function declaredEntries(
  text: string,
  declAt: number,
): { entries: string[]; foreign: string } | null {
  const eq = text.indexOf("=", declAt);
  if (eq < 0) return null;
  const entries: string[] = [];
  let residue = "";
  let depth = 0;
  for (let i = eq + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      i--;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return null;
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let lit = "";
      while (j < text.length && text[j] !== ch) {
        if (text[j] === "\\") j++;
        lit += text[j] ?? "";
        j++;
      }
      entries.push(lit);
      i = j;
      continue;
    }
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ";" && depth <= 0) break;
    else if (ch === "\n" && depth <= 0 && entries.length > 0) {
      // The statement ends at a newline unless the next code character
      // continues it (a chained call, an operator).
      let k = i + 1;
      for (;;) {
        while (k < text.length && /\s/.test(text[k]!)) k++;
        if (text[k] === "/" && text[k + 1] === "/") {
          while (k < text.length && text[k] !== "\n") k++;
        } else if (text[k] === "/" && text[k + 1] === "*") {
          const end = text.indexOf("*/", k + 2);
          if (end < 0) return null;
          k = end + 2;
        } else break;
      }
      if (!/[.+?|&]/.test(text[k] ?? "")) break;
    } else if (!/[\s,]/.test(ch)) residue += ch;
  }
  if (entries.length === 0) return null;
  const foreign = residue.replace(/newSet(?:<\w+>)?|asconst/g, "");
  return { entries, foreign };
}

/** Violations of the pairing rule over a set of test sources. Pure, so it can be proved. */
export function pairingViolations(
  testSources: Source[],
  readDbTest: (rel: string) => string | null,
): string[] {
  const out: string[] = [];
  for (const src of testSources) {
    const decls = [...src.text.matchAll(EXEMPTION_DECL)];
    const markers = [...src.text.matchAll(MARKER)].map((m) => ({
      at: m.index ?? 0,
      parts: m[1]!.split("|").map((x) => x.trim()),
    }));
    for (const d of decls) {
      const name = d[1]!;
      const at = d.index ?? 0;
      // The nearest marker ABOVE the declaration, so one marker cannot cover a
      // list declared pages away from it.
      const marker = markers.filter((m) => m.at < at).pop();
      if (!marker || at - marker.at > 600) {
        out.push(`${src.path}: ${name} has no exemption-db-pair marker directly above it`);
        continue;
      }
      const [dbPath, fn, entries] = marker.parts;
      if (!dbPath || !fn || !entries) {
        out.push(`${src.path}: ${name} marker must be "<db test> | <function> | <entries>"`);
        continue;
      }
      if (!/^tests\/db\/[\w./-]+\.db\.test\.ts$/.test(dbPath)) {
        out.push(`${src.path}: ${name} pairs with ${dbPath}, which is not a tests/db/*.db.test.ts file`);
        continue;
      }
      const db = readDbTest(dbPath);
      if (db === null) {
        out.push(`${src.path}: ${name} pairs with ${dbPath}, which does not exist`);
        continue;
      }
      if (!names(db, fn)) {
        out.push(`${src.path}: ${name}: ${dbPath} never names the real function ${fn}`);
      }
      const marked = entries.split(",").map((e) => e.trim()).filter(Boolean);
      // The list may also be extended OUTSIDE its initializer (Insurance F1):
      // a later `NAME.add(...)`, `.push`, `.concat`, `.unshift`, `.splice`, or a
      // reassignment of the name, adds entries the initializer scan cannot see.
      const n = escapeRe(name);
      for (const method of MUTATORS) {
        if (new RegExp(`(?<![\\w$])${n}\\s*\\.\\s*${method}\\s*\\(`).test(src.text)) {
          out.push(`${src.path}: ${name}: .${method}() is called on it, so the list can grow after its initializer where the guard cannot see`);
        }
      }
      const later = src.text.slice(at + d[0].length);
      if (new RegExp(`(?<![\\w$.])${n}\\s*(?:\\+|\\|\\||&&|\\?\\?)?=(?![=>])`).test(later)) {
        out.push(`${src.path}: ${name}: is reassigned after its declaration, so the list can change where the guard cannot see`);
      }
      const declared = declaredEntries(src.text, at);
      if (declared === null) {
        out.push(`${src.path}: ${name}: the guard cannot read its entries as string literals, so it cannot prove the pairing`);
        continue;
      }
      if (declared.foreign) {
        out.push(
          `${src.path}: ${name}: the initializer holds more than string literals (${declared.foreign}), so the guard cannot see every entry`,
        );
        continue;
      }
      const listed = declared.entries;
      // The LIST is the truth. An entry appended without updating the marker,
      // or a marker entry the list no longer holds, is a violation either way.
      for (const entry of listed) {
        if (!marked.includes(entry)) {
          out.push(`${src.path}: ${name}: the list holds ${entry}, which its exemption-db-pair marker does not name`);
        }
      }
      for (const entry of marked) {
        if (!listed.includes(entry)) {
          out.push(`${src.path}: ${name}: the marker names ${entry}, which the list no longer holds (stale marker)`);
        }
      }
      for (const entry of new Set([...listed, ...marked])) {
        if (!names(db, entry)) {
          out.push(`${src.path}: ${name}: ${dbPath} never exercises the exempted entry ${entry}`);
        }
      }
    }
  }
  return out;
}

function listTests(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listTests(full));
    else if (name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const readDb = (rel: string) => {
  const full = path.join(ROOT, rel);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
};

const REPO_SOURCES: Source[] = listTests(path.join(ROOT, "tests/migrations"))
  .filter((f) => !f.endsWith("exemption-db-pairing.test.ts"))
  .map((f) => ({ path: path.relative(ROOT, f), text: readFileSync(f, "utf8") }));

describe("G6(a) every migration-test exemption list is paired with a real-function DB test", () => {
  it("the repository's exemption lists are all paired", () => {
    expect(pairingViolations(REPO_SOURCES, readDb)).toEqual([]);
  });

  it("DISCOVERY: the guard still finds the 0214 exemption, so it cannot pass by scanning nothing", () => {
    const found = REPO_SOURCES.filter((s) => [...s.text.matchAll(EXEMPTION_DECL)].length > 0).map(
      (s) => s.path,
    );
    expect(found).toContain("tests/migrations/0214-history-init-source-contract.test.ts");
  });

  // NEGATIVE CONTROLS, on synthetic sources: the rule must fail each way it can.
  const DB_OK = `await init(); // initialize_thing\n// covers widgets`;
  const decl = (marker: string) => ({
    path: "tests/migrations/x.test.ts",
    text: `${marker}\nconst EXEMPT = ["widgets"];`,
  });
  const MARK = "// exemption-db-pair: tests/db/x.db.test.ts | initialize_thing | widgets";

  it("CONTROL: a fully paired list passes", () => {
    expect(pairingViolations([decl(MARK)], () => DB_OK)).toEqual([]);
  });

  it("CONTROL: an exemption with no marker is a violation", () => {
    expect(pairingViolations([decl("")], () => DB_OK).join()).toMatch(/no exemption-db-pair marker/);
  });

  it("CONTROL: a marker pointing at a missing DB test is a violation", () => {
    expect(pairingViolations([decl(MARK)], () => null).join()).toMatch(/does not exist/);
  });

  it("CONTROL: a DB test that never names the real function is a violation", () => {
    expect(pairingViolations([decl(MARK)], () => "covers widgets").join()).toMatch(
      /never names the real function/,
    );
  });

  it("CONTROL: a DB test that never exercises an exempted entry is a violation", () => {
    expect(pairingViolations([decl(MARK)], () => "initialize_thing").join()).toMatch(
      /never exercises the exempted entry widgets/,
    );
  });

  it("CONTROL: an entry appended to the list without updating the marker is a violation", () => {
    const appended = {
      path: "tests/migrations/x.test.ts",
      text: `${MARK}\nconst EXEMPT = ["widgets", "new_money_table_without_db_coverage"];`,
    };
    expect(pairingViolations([appended], () => DB_OK).join()).toMatch(
      /list holds new_money_table_without_db_coverage, which its exemption-db-pair marker does not name/,
    );
    // Even with the marker updated, the DB test must exercise the new entry.
    const marked = {
      path: appended.path,
      text: appended.text.replace("| widgets", "| widgets, new_money_table_without_db_coverage"),
    };
    expect(pairingViolations([marked], () => DB_OK).join()).toMatch(
      /never exercises the exempted entry new_money_table_without_db_coverage/,
    );
  });

  it("CONTROL: a marker entry the list no longer holds is a stale marker", () => {
    const stale = { path: "tests/migrations/x.test.ts", text: `${MARK}, gone_entry\nconst EXEMPT = ["widgets"];` };
    expect(pairingViolations([stale], () => `${DB_OK} gone_entry`).join()).toMatch(/gone_entry.*stale marker/);
  });

  it("CONTROL: entries are read across lines, Set forms and comments", () => {
    const multi = {
      path: "tests/migrations/x.test.ts",
      text: `${MARK}\nconst EXEMPT = new Set([\n  "widgets", // why\n  'sneaky',\n]);`,
    };
    expect(pairingViolations([multi], () => DB_OK).join()).toMatch(/list holds sneaky/);
  });

  it.each([
    ["a spread", `const EXEMPT = ["widgets", ...OTHER];`],
    ["an identifier element", `const EXEMPT = ["widgets", OTHER];`],
    ["a .concat", `const EXEMPT = ["widgets"].concat(OTHER);`],
    ["a .add on the same line", `const EXEMPT = new Set(["widgets"]).add("sneaky");`],
    ["a .add chained on the next line", `const EXEMPT = new Set(["widgets"])\n  .add("sneaky");`],
    ["a .push chained past a comment", `const EXEMPT = ["widgets"]\n  // why\n  .push("sneaky");`],
  ])("CONTROL: a list extended by %s is not read partially", (_form, init) => {
    const src = { path: "tests/migrations/x.test.ts", text: `${MARK}\n${init}` };
    expect(pairingViolations([src], () => DB_OK).join()).toMatch(/more than string literals/);
  });

  it.each([
    ["new Set with a generic", `const EXEMPT = new Set<string>(["widgets"]);`],
    ["as const", `const EXEMPT = ["widgets"] as const;`],
    ["comments between entries", `const EXEMPT = [\n  "widgets", // why\n  /* more */\n];`],
  ])("CONTROL: %s stays readable", (_form, init) => {
    const src = { path: "tests/migrations/x.test.ts", text: `${MARK}\n${init}` };
    expect(pairingViolations([src], () => DB_OK)).toEqual([]);
  });

  it.each([
    ["add", `EXEMPT.add("sneaky");`],
    ["push", `EXEMPT.push("sneaky");`],
    ["concat", `const MORE = EXEMPT.concat(["sneaky"]);`],
    ["unshift", `EXEMPT.unshift("sneaky");`],
    ["splice", `EXEMPT.splice(0, 0, "sneaky");`],
    ["spaced add", `EXEMPT\n  .add("sneaky");`],
  ])("CONTROL: a later statement calling .%s on the list is a violation", (_m, stmt) => {
    const src = { path: "tests/migrations/x.test.ts", text: `${MARK}\nconst EXEMPT = new Set(["widgets"]);\n${stmt}` };
    expect(pairingViolations([src], () => DB_OK).join()).toMatch(/can grow after its initializer/);
  });

  it("CONTROL: a reassigned let list is a violation, and an unrelated longer name is not", () => {
    const re = { path: "tests/migrations/x.test.ts", text: `${MARK}\nlet EXEMPT = ["widgets"];\nEXEMPT = [...EXEMPT, "sneaky"];` };
    expect(pairingViolations([re], () => DB_OK).join()).toMatch(/reassigned after its declaration/);
    const other = { path: "tests/migrations/x.test.ts", text: `${MARK}\nlet EXEMPT = ["widgets"];\nEXEMPT_NOTE.add("y");` };
    expect(pairingViolations([other], () => DB_OK)).toEqual([]);
  });

  it("CONTROL: the DB test must name the entry as a whole token, not as part of a longer one", () => {
    expect(pairingViolations([decl(MARK)], () => "initialize_thing\nmy_widgetsy").join()).toMatch(/never exercises the exempted entry widgets/);
  });

  it("CONTROL: a list the guard cannot read as string literals fails instead of passing", () => {
    const opaque = { path: "tests/migrations/x.test.ts", text: `${MARK}\nconst EXEMPT = computeExemptions();` };
    expect(pairingViolations([opaque], () => DB_OK).join()).toMatch(/cannot read its entries/);
  });

  it("CONTROL: a marker pointing at a source-contract test (not a DB test) is a violation", () => {
    const m = "// exemption-db-pair: tests/migrations/x.test.ts | initialize_thing | widgets";
    expect(pairingViolations([decl(m)], () => DB_OK).join()).toMatch(/not a tests\/db/);
  });

  it("CONTROL: a marker far above the list does not cover it", () => {
    const far = { path: "tests/migrations/x.test.ts", text: `${MARK}\n${"//\n".repeat(400)}const EXEMPT = ["widgets"];` };
    expect(pairingViolations([far], () => DB_OK).join()).toMatch(/no exemption-db-pair marker/);
  });
});
