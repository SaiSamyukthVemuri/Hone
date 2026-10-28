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
  /^\s*(?:export\s+)?const\s+((?=[A-Z0-9_]*(?:EXEMPT|WAIVE|NOT_[A-Z]+_(?:MONEY|PAYMENT|CLINICAL)))[A-Z][A-Z0-9_]*)\b/gm;
const MARKER = /^\s*\/\/\s*exemption-db-pair:\s*(.+)$/gm;

export type Source = { path: string; text: string };

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
      if (!db.includes(fn)) {
        out.push(`${src.path}: ${name}: ${dbPath} never names the real function ${fn}`);
      }
      for (const entry of entries.split(",").map((e) => e.trim()).filter(Boolean)) {
        if (!db.includes(entry)) {
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

  it("CONTROL: a marker pointing at a source-contract test (not a DB test) is a violation", () => {
    const m = "// exemption-db-pair: tests/migrations/x.test.ts | initialize_thing | widgets";
    expect(pairingViolations([decl(m)], () => DB_OK).join()).toMatch(/not a tests\/db/);
  });

  it("CONTROL: a marker far above the list does not cover it", () => {
    const far = { path: "tests/migrations/x.test.ts", text: `${MARK}\n${"//\n".repeat(400)}const EXEMPT = ["widgets"];` };
    expect(pairingViolations([far], () => DB_OK).join()).toMatch(/no exemption-db-pair marker/);
  });
});
