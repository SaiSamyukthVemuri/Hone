/**
 * A fail-closed census of the SQL functions the migrations define, as they stand at the LATEST migration.
 *
 * WHY. "Which functions insert an appointment" cannot be answered by grepping the files: a function is defined many times (create or replace), overloaded
 * by a trailing argument, dropped, or written with an unusual dollar tag, and a comment or a string can hold the words. The census scans each file with a
 * small SQL scanner (comments, '...' and E'...' strings, "..." identifiers, $tag$...$tag$ bodies), splits top-level statements, tracks each definition by
 * schema, name and argument list, applies drops, and keeps the LATEST body.
 *
 * FAIL CLOSED. Wherever the census cannot be sure it keeps the function and says so:
 *   - a `create function` statement it cannot parse (no readable name, argument list or body) is an UNPARSEABLE definition, counted as a possible
 *     inserter, never as absent;
 *   - a file that ends inside a quote or a comment marks its last statement unparseable;
 *   - a `drop function` that cannot be matched to exactly one definition keeps every candidate and is reported as an AMBIGUOUS DROP;
 *   - `alter function ... rename` or `... set schema` is reported (a renamed function would otherwise vanish from its old name), and so is a function
 *     created dynamically inside a string (a `create function` that is not itself a top-level statement).
 * The consumer treats every one of those lists as "must be empty or explicitly listed", so a new shape that the scanner cannot read fails a test
 * instead of passing it.
 *
 * Pure: it takes the files' text. The file system is the caller's.
 */

export type MigrationFile = { name: string; sql: string };

export type FunctionDef = {
  schema: string;
  name: string;
  /** The argument list as written, lower-cased, with defaults removed and whitespace collapsed (the overload identity). */
  args: string;
  arity: number;
  /** The body text with comments removed (strings are KEPT: a dynamic `execute 'insert into ...'` is an insert). */
  body: string;
  file: string;
};

export type Unparseable = { file: string; reason: string; excerpt: string };

export type Census = {
  /** The functions that exist after the last migration, keyed `schema.name(args)`. */
  functions: Map<string, FunctionDef>;
  unparseable: Unparseable[];
  ambiguousDrops: { file: string; statement: string }[];
  renames: { file: string; statement: string }[];
  dynamicDefinitions: { file: string; excerpt: string }[];
};

// ---- the scanner -------------------------------------------------------------------------------------------------------------------------------------

type Scan = { statements: string[]; unterminated: boolean };

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);

/** Match a `$tag$` opener at `i` (not preceded by a word character, so `$1` is not one). Returns the full opener or null. */
function dollarOpener(sql: string, i: number): string | null {
  if (sql[i] !== "$" || isWord(sql[i - 1])) return null;
  const m = /^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 80));
  return m ? m[0] : null;
}

/**
 * Remove comments (PostgreSQL block comments nest) and split on top-level semicolons. Strings, identifiers and dollar-quoted bodies are copied through
 * whole, so a `--` or a `;` inside them changes nothing.
 */
export function scan(sql: string): Scan {
  const statements: string[] = [];
  let cur = "";
  let i = 0;
  let unterminated = false;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === "-" && d === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) unterminated = true;
      cur += " ";
      continue;
    }
    if (c === "'") {
      const escaped = /^[eE]$/.test(sql[i - 1] ?? "") && !isWord(sql[i - 2]);
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (escaped && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) unterminated = true;
      cur += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) unterminated = true;
      cur += sql.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const open = dollarOpener(sql, i);
      if (open) {
        const end = sql.indexOf(open, i + open.length);
        if (end === -1) {
          unterminated = true;
          cur += sql.slice(i);
          i = n;
        } else {
          // Copy the body whole, then remove comments INSIDE it with the same scanner (a body is SQL/plpgsql), keeping its strings.
          const inner = sql.slice(i + open.length, end);
          cur += open + stripComments(inner) + open;
          i = end + open.length;
        }
        continue;
      }
    }
    if (c === ";") {
      statements.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== "") statements.push(cur);
  return { statements, unterminated };
}

/** Comments removed, everything else (strings, nested dollar bodies) kept. */
export function stripComments(sql: string): string {
  // Reuse the scanner on a single "statement": join the pieces back with the semicolons the split removed.
  const { statements } = scan(sql.replace(/;/g, "\u0001"));
  return statements.join("").replace(/\u0001/g, ";");
}

// ---- parsing the statements ----------------------------------------------------------------------------------------------------------------------------

/** The text inside the balanced parentheses starting at `open` (the index of "("), or null. Quotes are respected. */
function balanced(text: string, open: number): { inner: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const q = c;
      i++;
      while (i < text.length && !(text[i] === q && text[i + 1] !== q)) i += text[i] === q ? 2 : 1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i };
    }
  }
  return null;
}

function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < list.length && !(list[j] === q && list[j + 1] !== q)) j += list[j] === q ? 2 : 1;
      cur += list.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") out.push(cur);
  return out;
}

/**
 * PostgreSQL spells one type several ways and treats them as ONE function: `timestamptz` and `timestamp with time zone`, `int` and `integer`. A census
 * that keyed on the spelling would keep a replaced definition beside its replacement (0152 and 0220 did exactly that for one command), so the aliases
 * are folded to one name before the overload identity is built.
 */
const TYPE_ALIASES: [RegExp, string][] = [
  [/\btimestamp\s+with\s+time\s+zone\b/g, "timestamptz"],
  [/\btimestamp\s+without\s+time\s+zone\b/g, "timestamp"],
  [/\btime\s+with\s+time\s+zone\b/g, "timetz"],
  [/\btime\s+without\s+time\s+zone\b/g, "time"],
  [/\bdouble\s+precision\b/g, "float8"],
  [/\bcharacter\s+varying\b/g, "varchar"],
  [/\bbigint\b/g, "int8"],
  [/\bsmallint\b/g, "int2"],
  [/\b(?:integer|int)\b/g, "int4"],
  [/\b(?:boolean)\b/g, "bool"],
  [/\breal\b/g, "float4"],
  [/\bdecimal\b/g, "numeric"],
  [/\bpublic\./g, ""],
];

/** One argument without its default and mode, lower-cased, type aliases folded, whitespace collapsed. */
function normArg(arg: string): string {
  let a = arg.replace(/\s+/g, " ").trim();
  const m = /\s(?:default\s|=\s?)/i.exec(a);
  if (m) a = a.slice(0, m.index);
  a = a.replace(/^(?:inout|in|out|variadic)\s+/i, "").trim().toLowerCase();
  for (const [re, to] of TYPE_ALIASES) a = a.replace(re, to);
  return a.replace(/\s+/g, " ").trim();
}

export function normArgs(list: string): string[] {
  return splitTop(list).map(normArg).filter((s) => s !== "");
}

const IDENT = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*)`;
const QNAME = String.raw`(${IDENT})(?:\s*\.\s*(${IDENT}))?`;
const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toLowerCase());

function parseName(a: string, b: string | undefined): { schema: string; name: string } {
  return b === undefined ? { schema: "public", name: unquote(a) } : { schema: unquote(a), name: unquote(b) };
}

const CREATE_HEAD = new RegExp(String.raw`^\s*create\s+(?:or\s+replace\s+)?function\s+${QNAME}\s*\(`, "i");
const LOOKS_LIKE_CREATE = /\bcreate\s+(?:or\s+replace\s+)?function\b/i;

function parseCreate(stmt: string, file: string): { def?: FunctionDef; bad?: Unparseable } {
  const head = CREATE_HEAD.exec(stmt);
  const excerpt = stmt.replace(/\s+/g, " ").trim().slice(0, 140);
  if (!head) return { bad: { file, reason: "create function with no readable name and argument list", excerpt } };
  const { schema, name } = parseName(head[1], head[2]);
  const open = head[0].length - 1;
  const args = balanced(stmt, open);
  if (!args) return { bad: { file, reason: `${name}: argument list is not balanced`, excerpt } };
  const rest = stmt.slice(args.end + 1);
  // A quoted body: `as $tag$ ... $tag$` (or the old `as '...'`).
  const asm = /\bas\s+(\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$|')/i.exec(rest);
  let body: string | null = null;
  if (asm) {
    const opener = asm[1];
    const from = asm.index + asm[0].length;
    if (opener === "'") {
      let j = from;
      while (j < rest.length && !(rest[j] === "'" && rest[j + 1] !== "'")) j += rest[j] === "'" ? 2 : 1;
      body = j < rest.length ? rest.slice(from, j).replace(/''/g, "'") : null;
    } else {
      const end = rest.indexOf(opener, from);
      body = end === -1 ? null : rest.slice(from, end);
    }
  } else if (/\bbegin\s+atomic\b/i.test(rest) || /\breturn\b/i.test(rest)) {
    // The SQL-standard bodies have no quotes; the whole remainder is the body (a conservative reading).
    body = rest;
  }
  if (body === null) return { bad: { file, reason: `${name}: no readable body`, excerpt } };
  const norm = normArgs(args.inner);
  return { def: { schema, name, args: norm.join(", "), arity: norm.length, body, file } };
}

const keyOf = (d: { schema: string; name: string; args: string }) => `${d.schema}.${d.name}(${d.args})`;

/** `drop function [if exists] a(args), b(args) [cascade|restrict]` */
function applyDrop(stmt: string, file: string, functions: Map<string, FunctionDef>, ambiguous: Census["ambiguousDrops"]): boolean {
  const m = /^\s*drop\s+function\s+(?:if\s+exists\s+)?([\s\S]*)$/i.exec(stmt);
  if (!m) return false;
  const text = m[1].replace(/\s+(?:cascade|restrict)\s*$/i, "");
  for (const item of splitTop(text)) {
    const nm = new RegExp(String.raw`^\s*${QNAME}\s*(\(|$)`, "i").exec(item);
    if (!nm) {
      ambiguous.push({ file, statement: item.replace(/\s+/g, " ").trim().slice(0, 140) });
      continue;
    }
    const { schema, name } = parseName(nm[1], nm[2]);
    const candidates = [...functions.values()].filter((f) => f.schema === schema && f.name === name);
    if (candidates.length === 0) continue; // dropping something this census never saw defined: nothing to keep or remove
    let argList: string[] | null = null;
    if (nm[3] === "(") {
      const bal = balanced(item, item.indexOf("("));
      argList = bal ? normArgs(bal.inner) : null;
    }
    let target: FunctionDef | undefined;
    if (argList) {
      const exact = candidates.find((f) => f.args === argList!.join(", "));
      if (exact) target = exact;
      else {
        const sameArity = candidates.filter((f) => f.arity === argList!.length);
        if (sameArity.length === 1) target = sameArity[0];
      }
    } else if (candidates.length === 1) {
      target = candidates[0];
    }
    if (target) functions.delete(keyOf(target));
    else ambiguous.push({ file, statement: item.replace(/\s+/g, " ").trim().slice(0, 140) }); // keep every candidate
  }
  return true;
}

/** Build the census from the files, which must be given in migration order. */
export function buildCensus(files: readonly MigrationFile[]): Census {
  const functions = new Map<string, FunctionDef>();
  const census: Census = { functions, unparseable: [], ambiguousDrops: [], renames: [], dynamicDefinitions: [] };
  for (const f of files) {
    const { statements, unterminated } = scan(f.sql);
    statements.forEach((stmt, idx) => {
      const last = idx === statements.length - 1;
      if (unterminated && last) {
        census.unparseable.push({ file: f.name, reason: "the file ends inside a quote or a comment", excerpt: stmt.replace(/\s+/g, " ").trim().slice(0, 140) });
        return;
      }
      if (/^\s*create\s+(?:or\s+replace\s+)?function\b/i.test(stmt)) {
        const r = parseCreate(stmt, f.name);
        if (r.def) functions.set(keyOf(r.def), r.def);
        else if (r.bad) census.unparseable.push(r.bad);
        return;
      }
      if (/^\s*drop\s+function\b/i.test(stmt)) {
        applyDrop(stmt, f.name, functions, census.ambiguousDrops);
        return;
      }
      if (/^\s*alter\s+function\b/i.test(stmt) && /\b(?:rename\s+to|set\s+schema)\b/i.test(stmt)) {
        census.renames.push({ file: f.name, statement: stmt.replace(/\s+/g, " ").trim().slice(0, 140) });
        return;
      }
      // A function created inside a string (a DO block, an execute): it is not a top-level statement, so the census cannot track it.
      if (LOOKS_LIKE_CREATE.test(stmt)) census.dynamicDefinitions.push({ file: f.name, excerpt: stmt.replace(/\s+/g, " ").trim().slice(0, 140) });
    });
    if (unterminated && statements.length === 0) census.unparseable.push({ file: f.name, reason: "the file ends inside a quote or a comment", excerpt: "" });
  }
  return census;
}

// ---- the question this census exists for -----------------------------------------------------------------------------------------------------------

/** `insert into [only] [public.]appointments` (any quoting), a `merge into` it, or the same words inside a string (dynamic SQL). */
const APPOINTMENT_INSERT = new RegExp(
  String.raw`\b(?:insert\s+into|merge\s+into)\s+(?:only\s+)?(?:(?:"public"|public)\s*\.\s*)?(?:"appointments"|appointments)(?![A-Za-z0-9_$])`,
  "i",
);

export function insertsAppointment(def: FunctionDef): boolean {
  return APPOINTMENT_INSERT.test(def.body);
}

/** A stable, argument-list-free label: `name/arity` (a new trailing parameter changes the arity, so it is a deliberate change to the pinned list). */
export const labelOf = (d: Pick<FunctionDef, "schema" | "name" | "arity">) => `${d.schema === "public" ? "" : d.schema + "."}${d.name}/${d.arity}`;

export function appointmentInserters(c: Census): string[] {
  return [...c.functions.values()].filter(insertsAppointment).map(labelOf).sort();
}

/**
 * Every function that reaches an appointment insert: the direct inserters plus, transitively, any function whose body calls one of them by name. Name
 * matching is by identifier (not a substring of a longer name) and is deliberately generous: an extra caller is a line in a pinned list a reviewer reads,
 * a missed one is a hole. Returns `name/arity` labels, sorted.
 */
export function appointmentCreationSurface(c: Census): { direct: string[]; viaCalls: string[] } {
  const defs = [...c.functions.values()];
  const direct = new Set(defs.filter(insertsAppointment).map((d) => d.name));
  const reach = new Set(direct);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of defs) {
      if (reach.has(d.name)) continue;
      for (const callee of reach) {
        if (new RegExp(String.raw`(?<![A-Za-z0-9_$])${callee}\s*\(`, "i").test(d.body)) {
          reach.add(d.name);
          grew = true;
          break;
        }
      }
    }
  }
  const labels = (pred: (d: FunctionDef) => boolean) => defs.filter(pred).map(labelOf).sort();
  return { direct: labels((d) => direct.has(d.name) && insertsAppointment(d)), viaCalls: labels((d) => reach.has(d.name) && !insertsAppointment(d)) };
}

/**
 * Live definitions that share a schema, name and arity. Two of them are either a REAL overload (a new trailing parameter is how the booking commands will
 * gain their key) or one function the scanner failed to fold into its replacement (a spelling the alias list does not know). The census cannot tell which,
 * so it reports both and the consumer pins the real ones by name: an unknown pair fails.
 */
export function sameArityGroups(c: Census): string[] {
  const g = new Map<string, number>();
  for (const d of c.functions.values()) g.set(labelOf(d), (g.get(labelOf(d)) ?? 0) + 1);
  return [...g].filter(([, n]) => n > 1).map(([l]) => l).sort();
}

/** Everything the census could not read or track, as one list. Any entry is an UNKNOWN INSERTER: the consumer requires it to be empty or explicitly named. */
export function unknownInserters(c: Census): string[] {
  return [
    ...c.unparseable.map((u) => `unparseable: ${u.file}: ${u.reason}: ${u.excerpt}`),
    ...c.ambiguousDrops.map((d) => `ambiguous drop: ${d.file}: ${d.statement}`),
    ...c.renames.map((r) => `rename: ${r.file}: ${r.statement}`),
    ...c.dynamicDefinitions.map((d) => `dynamic definition: ${d.file}: ${d.excerpt}`),
  ];
}
