import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { buildCardChangeNotification } from "@/lib/billing/card-change-notification";
import { WAITLIST_OFFER_DECLINED_BODY, WAITLIST_OFFER_DECLINED_TITLE } from "@/lib/notifications/waitlist-offer-declined";

// Privacy rule. RLS lets every studio member READ every row of practitioner_notifications (and, until the UPDATE policy is column-limited, rewrite
// one), so what a notification SAYS stays minimal. It may carry: the client's display name, a service name, a time, a staff display name, and for
// owner-only card events a card brand and last four. It must NEVER carry a block's private note, a legal name, clinical text or an intake answer.
//
// HOW THIS IS PINNED (deliberately CONSERVATIVE: a false positive is acceptable, a miss is not):
//   1. WRITERS ARE DISCOVERED, not listed from memory: every source file outside tests that names the table, or any writer function, anywhere in the
//      repository (app, lib, components, scripts, supabase/functions, root files). A file outside the reviewed set fails.
//   2. An `as` alias of a writer function fails (the call would no longer be found by name).
//   3. Each reviewed writer file is scanned for forbidden fields in (a) every writer call IN FULL, with no field-order assumption, and (b) every
//      declaration those calls refer to (`const body = ...`, `const base = {...}`, spreads) plus any title/body/base/message declaration in the file.
//   4. Every migration that inserts into the table is discovered and the full list is pinned.
// NOTE: discovery reads `git ls-files`, so an UNCOMMITTED new file is invisible to a local run (CI runs on the committed tree). This is a TRIPWIRE, not proof.
// The functions are pure over a {path: source} map so the negative controls at the bottom run the SAME scan over forged sources.
//
// RESIDUAL LIMITS OF THE ARGUMENT SCAN (known, deliberately unfixed: a scanner that chases every spelling only invites the next miss). The scan
// follows `await name(...)` and `await a.b.name(...)`, so a private field handed to a name loader is seen. It does NOT see: an optional-chained
// call (`names?.load(row.legal_given_name)`), a call on an awaited expression (`(await getLoader()).load(...)`), a `.then` chain, or a name
// assigned in two steps (`let x; x = await load(...)`). The durable fix is structural, not a better regex: the notification wording is now made
// by pure builders (lib/notifications/notification-text.ts) whose parameters are the only content, and which tests/lib/notifications/
// notification-text.test.ts pins by behaviour. Prefer extending those builders over extending this scan.

export type Sources = Record<string, string>;

const FN_NAMES = ["recordPractitionerNotification", "recordPractitionerNotificationAndWait", "ensurePractitionerNotification"];
const TABLE = "practitioner_notifications";

// Reviewed. WRITERS emit text; READERS only select/update (asserted: no insert/upsert in them); the HELPER is the one module that inserts.
const REVIEWED_WRITERS = [
  "app/book/[slug]/actions.ts",
  "app/intake/[token]/actions.ts",
  "app/portal/rebook-actions.ts",
  "app/reschedule/[token]/actions.ts",
  "lib/billing/card-change-notification.ts",
  "lib/notifications/appointment-cancel-notification.ts",
];
const HELPER = "lib/notifications/practitioner-notifications.ts";
const REVIEWED_READERS = [
  "app/(app)/layout.tsx",
  "app/(app)/notifications/actions.ts",
  "app/(app)/notifications/page.tsx",
  "app/api/notifications/summary/route.ts",
  "lib/export/resource-registry.ts",
  "lib/notifications/owner-only-events.ts",
];
// The ONLY migrations that insert into the table (SQL writers). 0325 writes a fixed title and an empty body.
const REVIEWED_INSERTING_MIGRATIONS = ["supabase/migrations/0325_waitlist_decline_followups.sql"];

const FORBIDDEN = [
  /legal[_ ]?name|legalName/i,
  /legal_(given|middle|family|full)_name/i,
  /private[_ ]?note/i,
  /\bnote(s)?\b/i,
  /clinical/i,
  /chart/i,
  /intake[_ ]?(answers?|responses?|data)/i,
  /\banswers?\b/i,
  /\bresponses?\b/i,
  /diagnos/i,
  /allerg/i,
  /medic/i,
  /health/i,
  /date_of_birth|\bdob\b|birthday/i,
  /\bphone\b|\bemail\b/i,
  /address/i,
  /payload/i,
];

const LEGAL_IDENTITY_READS = [
  /legal_(given|middle|family|full)_name/i,
  /legal[_ ]?name|legalName/i,
  /legal-identity/i,
  /\b(readLegalIdentity|readLegalNamesForStudio|readLegalNamesForClients|LEGAL_IDENTITY_COLUMNS|LegalIdentityRow)\b/,
  /client_legal_identit/i,
];

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

// Index just past a string/template literal that starts at `i`.
function skipLiteral(src: string, i: number): number {
  const q = src[i];
  i++;
  if (q !== "`") {
    while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
    return i + 1;
  }
  let depth = 0;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (depth === 0 && src[i] === "`") return i + 1;
    else {
      if (src[i] === "$" && src[i + 1] === "{") {
        depth++;
        i++;
      } else if (src[i] === "{" && depth > 0) depth++;
      else if (src[i] === "}" && depth > 0) depth--;
      i++;
    }
  }
  return i;
}

// Text from the bracket at `open` to its matching close, honouring literals.
function balanced(src: string, open: number): string {
  const close: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let i = open;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipLiteral(src, i);
      continue;
    }
    if (close[c]) stack.push(close[c]);
    else if (stack.length && c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return src.slice(open, i + 1);
    }
    i++;
  }
  return src.slice(open);
}

// One statement from `start`: up to the first `;` at bracket depth 0.
function statement(src: string, start: number): string {
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") i = skipLiteral(src, i);
    else if ("{([".includes(c)) i += balanced(src, i).length;
    else if (c === ";") return src.slice(start, i);
    else i++;
  }
  return src.slice(start);
}

const CALL = new RegExp(`\\b(?:${FN_NAMES.join("|")})\\s*\\(`, "g");

function callObjects(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(CALL)) out.push(balanced(code, (m.index ?? 0) + m[0].length - 1)); // the WHOLE argument list
  return out;
}

// Every declaration the calls refer to (spreads, `title: x`, `body: x`) plus every title/body/base/message declaration in the file.
const RESERVED = new Set("if else for while switch catch function return await async new typeof void try do case default with of in".split(" "));

function resolvedDeclarations(code: string, calls: string[]): string[] {
  const wanted = new Set<string>(["title", "body", "base", "message", "text", "payload", "content"]);
  const grab = (t: string) => {
    // Conservative: EVERY identifier in the scanned text is followed to its declaration (spreads, `body: x`, and anything interpolated).
    for (const m of t.matchAll(/[A-Za-z_$][\w$]*/g)) wanted.add(m[0]);
    // (a read, `await ...`, `.from(`, `.select(`, `.rpc(`, is data access and not message text: it is skipped when scanned below, not followed.)
  };
  calls.forEach(grab);
  const found: string[] = [];
  const done = new Set<string>();
  for (let round = 0; round < 6; round++) {
    for (const name of [...wanted]) {
      if (done.has(name) || RESERVED.has(name)) continue;
      done.add(name);
      const esc = name.replace(/\$/g, "\\$");
      // const/let/var declarations
      for (const m of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${esc}\\b[^=;]*=`, "g"))) {
        const stmt = statement(code, m.index ?? 0);
        // Only genuine data reads are skipped; an awaited call is followed (its identifiers are queued by grab below).
        if (/\.from\(|\.select\(|\.rpc\(/.test(stmt)) continue;
        if (/\bawait\b/.test(stmt)) {
          // An awaited call: its arguments are data, not text. Follow the CALLED identifier (its definition is scanned), not the statement.
          for (const c of stmt.matchAll(/\bawait\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g)) {
            wanted.add(c[1].split(".").pop() as string);
            // The result of this call flows into a name that reaches a notification, so what is PASSED IN matters too: a private
            // field handed to a name loader (`await loadName(admin, id, row.legal_given_name)`) is scanned and its identifiers followed.
            const open = (c.index ?? 0) + c[0].length - 1;
            const args = balanced(stmt, open);
            found.push(args);
            grab(args);
          }
          continue;
        }
        found.push(stmt);
        grab(stmt);
      }
      // function declarations and class/object-method builders: `function name(...) {...}`, `async function name`, `name(...) {...}`
      for (const m of code.matchAll(new RegExp(`(?:\\bfunction\\s+${esc}\\b|^[ \\t]*(?:async\\s+)?${esc})\\s*(?:<[^>]*>)?\\(`, "gm"))) {
        const paren = (m.index ?? 0) + m[0].length - 1;
        const params = balanced(code, paren);
        const rest = code.slice(paren + params.length);
        const brace = rest.match(/^\s*(?::[^{;]+)?\{/);
        if (!brace) continue; // a call, not a definition
        const bodyText = balanced(code, paren + params.length + brace[0].length - 1);
        const text = `${params}${bodyText}`;
        found.push(text);
        grab(text);
      }
    }
  }
  return found;
}

function discoverWriters(files: Sources) {
  const writers: string[] = [];
  const aliases: string[] = [];
  const directInserts: string[] = [];
  for (const [path, raw] of Object.entries(files)) {
    if (/^(tests|e2e|docs|openwiki|node_modules)\//.test(path) || /\.test\.[tj]sx?$/.test(path) || path.startsWith("supabase/migrations/")) continue;
    const src = stripComments(raw);
    const named = FN_NAMES.some((n) => new RegExp(`\\b${n}\\b`).test(src));
    if (!named && !src.includes(TABLE)) continue;
    writers.push(path);
    for (const n of FN_NAMES) if (new RegExp(`\\b${n}\\s+as\\s+\\w+`).test(src)) aliases.push(`${path}:${n}`);
    if (/\.from\(\s*["'`]practitioner_notifications["'`]\s*\)\s*\.\s*(insert|upsert)\b/.test(src)) directInserts.push(path);
  }
  return { writers: writers.sort(), aliases, directInserts };
}

const INSERT_INTO_TABLE = /insert\s+into\s+(?:"?public"?\s*\.\s*)?"?practitioner_notifications"?/i;
const migrationsInserting = (files: Sources) =>
  Object.keys(files)
    .filter((p) => p.startsWith("supabase/migrations/") && INSERT_INTO_TABLE.test(files[p]))
    .sort();

// A migration that BUILDS the table name (concatenation) or runs dynamic SQL (`execute`) that names it is not pinnable by the insert match: flag it.
const migrationsBuildingTheName = (files: Sources) =>
  Object.keys(files)
    .filter((p) => {
      if (!p.startsWith("supabase/migrations/")) return false;
      const sql = files[p];
      if (/practitioner_(?:'|")?\s*\|\||\|\|\s*(?:'|")?(?:notifications)\b|'practitioner'\s*\|\|/i.test(sql)) return true;
      return [...sql.matchAll(/\bexecute\b[^;]*;/gi)].some((m) => /practitioner_notif|notifications/i.test(m[0]));
    })
    .sort();

function contentViolations(path: string, src: string): string[] {
  const code = stripComments(src);
  const calls = callObjects(code);
  const out: string[] = [];
  for (const text of [...calls, ...resolvedDeclarations(code, calls)]) for (const re of FORBIDDEN) if (re.test(text)) out.push(`${path}: forbidden ${re}`);
  return out;
}

function reviewViolations(files: Sources): string[] {
  const { writers, aliases, directInserts } = discoverWriters(files);
  const reviewed = new Set([...REVIEWED_WRITERS, HELPER, ...REVIEWED_READERS]);
  const out: string[] = [];
  for (const w of writers) if (!reviewed.has(w)) out.push(`unreviewed file mentions the notification table or a writer: ${w}`);
  for (const a of aliases) out.push(`aliased writer import: ${a}`);
  for (const d of directInserts) if (d !== HELPER) out.push(`direct insert outside the helper: ${d}`);
  for (const r of REVIEWED_READERS) if (files[r] && /\.\s*(insert|upsert)\s*\(/.test(stripComments(files[r]))) out.push(`reader inserts: ${r}`);
  if (JSON.stringify(migrationsInserting(files)) !== JSON.stringify([...REVIEWED_INSERTING_MIGRATIONS].sort())) {
    out.push(`migrations inserting into the table changed: ${migrationsInserting(files).join(",")}`);
  }
  for (const m of migrationsBuildingTheName(files)) out.push(`migration builds or executes the notification table name dynamically: ${m}`);
  for (const w of REVIEWED_WRITERS) if (files[w]) out.push(...contentViolations(w, files[w]));
  for (const w of [...REVIEWED_WRITERS, HELPER]) {
    const code = stripComments(files[w] ?? "");
    for (const re of LEGAL_IDENTITY_READS) if (re.test(code)) out.push(`${w}: legal identity read ${re}`);
  }
  return out;
}

function realSources(): Sources {
  const out: Sources = {};
  for (const p of execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean)) {
    if (/^(tests|e2e|docs|openwiki|node_modules)\//.test(p) || !/\.(tsx?|jsx?|mjs|cjs|sql)$/.test(p)) continue;
    try {
      out[p] = readFileSync(p, "utf8");
    } catch {
      /* deleted in the working tree */
    }
  }
  return out;
}

describe("notification content: no private, legal, clinical or intake text (real repository)", () => {
  const real = realSources();

  it("the scan covers the whole source tree", () => {
    const roots = new Set(Object.keys(real).map((p) => p.split("/")[0]));
    for (const r of ["app", "lib", "components", "scripts", "supabase"]) expect(roots.has(r), r).toBe(true);
    expect(Object.keys(real).filter((p) => p.startsWith("supabase/migrations/")).length).toBeGreaterThan(200);
  });

  it("every file naming the table or a writer is reviewed; no alias, no direct insert, migrations pinned, no forbidden text, no legal identity", () => {
    expect(reviewViolations(real)).toEqual([]);
  });

  it("not vacuous: every reviewed writer yields a call, and the cancel writer's out-of-call text is resolved", () => {
    let total = 0;
    for (const w of REVIEWED_WRITERS) {
      const n = callObjects(stripComments(real[w])).length;
      expect(n, w).toBeGreaterThan(0);
      total += n;
    }
    expect(total).toBeGreaterThanOrEqual(7);
    const cancel = stripComments(real["lib/notifications/appointment-cancel-notification.ts"]);
    expect(resolvedDeclarations(cancel, callObjects(cancel)).join("\n")).toMatch(/cancelled/);
  });

  it("the card-change builder and the waitlist constants carry only the allowed fields", () => {
    for (const isReplacement of [false, true]) {
      const n = buildCardChangeNotification({ clientName: "Pat Example", brand: "visa", last4: "4242", isReplacement, clientId: "c1" });
      expect(`${n.title} ${n.body}`).toMatch(/Pat Example/);
      for (const re of FORBIDDEN) expect(`${n.title} ${n.body}`).not.toMatch(re);
      expect(n.href).toBe("/clients/c1?tab=billing");
    }
    expect(WAITLIST_OFFER_DECLINED_BODY).toBe("");
    expect(WAITLIST_OFFER_DECLINED_TITLE).toBe("A waitlist response needs your attention");
  });

  it("the SQL writers (0325) carry a fixed title and an empty body", () => {
    const inserts = [...real[REVIEWED_INSERTING_MIGRATIONS[0]].matchAll(/insert into public\.practitioner_notifications[^;]*?values\s*\(([^;]*?)\)\s*on conflict/gis)];
    expect(inserts.length).toBe(2);
    for (const m of inserts) expect(m[1]).toContain("'A waitlist response needs your attention', ''");
  });

  it("the cancel writer's reason is a closed label from a fixed list, never the free-text note", () => {
    const caller = readFileSync("app/cancel/[token]/actions.ts", "utf8");
    expect(caller).toContain("isCancellationReasonValue(rawReason)");
    expect(caller).toContain("reasonLabel = getCancellationReasonLabel(rawReason)");
    expect(readFileSync("lib/booking/cancellation-reasons.ts", "utf8")).toContain("CANCELLATION_REASONS");
  });
});

// NEGATIVE CONTROLS: the same scan over FORGED sources. Each must be flagged; if one passes, the guard has a hole.
describe("negative controls: forged writers are caught", () => {
  const clean: Sources = Object.fromEntries([...REVIEWED_WRITERS, HELPER, ...REVIEWED_READERS].map((p) => [p, ""]));
  const migOk = { "supabase/migrations/0325_waitlist_decline_followups.sql": "insert into public.practitioner_notifications (a) values (1)" };

  it("baseline: clean files plus the pinned migration have no violations", () => {
    expect(reviewViolations({ ...clean, ...migOk })).toEqual([]);
  });

  it("1. title/body built OUTSIDE the call (const body / const base / spread) are resolved and scanned", () => {
    const src = [
      "const body = `${block.private_note} for ${client.name}`;",
      "const base = { title: 'x', body };",
      "recordPractitionerNotificationAndWait({ ...base, studioId: s });",
    ].join("\n");
    const v = reviewViolations({ ...clean, ...migOk, "lib/notifications/appointment-cancel-notification.ts": src });
    expect(v.some((x) => /appointment-cancel-notification/.test(x) && /private/.test(x))).toBe(true);
  });

  it("1b. text reached only through an interpolated variable (const reason -> body -> base -> spread) is followed", () => {
    const src = [
      "const reason = ` ${row.private_note}`;",
      "const body = `${name} cancelled.${reason}`;",
      "const base = { title: 'x', body };",
      "recordPractitionerNotificationAndWait({ ...base });",
    ].join("\n");
    expect(reviewViolations({ ...clean, ...migOk, "lib/notifications/appointment-cancel-notification.ts": src }).some((x) => /private/.test(x))).toBe(true);
  });

  it("2. a body placed AFTER href and dedupeKey is still scanned", () => {
    const src = "recordPractitionerNotification({ studioId, href: `/x`, dedupeKey: 'k', appointmentId: null, body: `${c.legal_name} booked` });";
    expect(reviewViolations({ ...clean, ...migOk, "app/book/[slug]/actions.ts": src }).some((x) => /legal/.test(x))).toBe(true);
  });

  it("3. an aliased import is flagged", () => {
    const src = "import { recordPractitionerNotification as notifyX } from '@/lib/x';\nnotifyX({ body: 'hi' });";
    expect(reviewViolations({ ...clean, ...migOk, "app/intake/[token]/actions.ts": src }).some((x) => /aliased writer import/.test(x))).toBe(true);
  });

  it("4. a new file doing a direct insert into the table is flagged", () => {
    const v = reviewViolations({ ...clean, ...migOk, "lib/new-thing.ts": "await admin.from('practitioner_notifications').insert({ title: 'x' });" });
    expect(v.some((x) => /direct insert outside the helper/.test(x))).toBe(true);
    expect(v.some((x) => /unreviewed file/.test(x))).toBe(true);
  });

  it.each(["components/x.tsx", "scripts/seed.mjs", "supabase/functions/notify/index.ts"])("5. a new writer under %s is discovered", (p) => {
    expect(reviewViolations({ ...clean, ...migOk, [p]: "recordPractitionerNotification({ body: 'x' });" }).some((x) => x.includes(p))).toBe(true);
  });

  it("6. a new migration inserting into the table is flagged; so is losing the pinned one", () => {
    const added = reviewViolations({ ...clean, ...migOk, "supabase/migrations/0999_new.sql": "insert into public.practitioner_notifications (title) values ('x');" });
    expect(added.some((x) => /migrations inserting/.test(x))).toBe(true);
    expect(reviewViolations({ ...clean }).some((x) => /migrations inserting/.test(x))).toBe(true);
  });

  it("7a. text built by a `function` declaration or a class-method builder is followed", () => {
    const fn = "function buildBody(row) { return `${row.private_note} cancelled`; }\nconst body = buildBody(r);\nrecordPractitionerNotificationAndWait({ title: 't', body });";
    expect(reviewViolations({ ...clean, ...migOk, "lib/notifications/appointment-cancel-notification.ts": fn }).some((x) => /private/.test(x))).toBe(true);
    const asyncFn = "async function compose(row) { return `${row.legal_name}`; }\nconst body = await compose(r);\nrecordPractitionerNotificationAndWait({ title: 't', body });";
    expect(reviewViolations({ ...clean, ...migOk, "lib/notifications/appointment-cancel-notification.ts": asyncFn }).some((x) => /legal/.test(x))).toBe(true);
    const method = "class B {\n  build(row) {\n    return `${row.clinical_notes}`;\n  }\n}\nconst body = new B().build(r);\nrecordPractitionerNotificationAndWait({ title: 't', body });";
    expect(reviewViolations({ ...clean, ...migOk, "lib/notifications/appointment-cancel-notification.ts": method }).some((x) => /clinical|notes?/.test(x))).toBe(true);
  });

  it("7b. an AWAITED declaration is followed through the called identifier, not skipped", () => {
    const src = "const body = await makeText(r);\nconst makeText = (row) => `${row.intake_answers}`;\nrecordPractitionerNotification({ title: 't', body });";
    expect(reviewViolations({ ...clean, ...migOk, "app/book/[slug]/actions.ts": src }).some((x) => /intake|answers/.test(x))).toBe(true);
  });

  it("7b2. the ARGUMENTS of an awaited call whose result becomes the body are scanned: a private field passed into a name loader", () => {
    const W = "app/book/[slug]/actions.ts";
    const direct = "const name = await loadCommunicationName(admin, studioId, clientId, row.legal_given_name);\nrecordPractitionerNotification({ title: 't', body: `${name} booked` });";
    expect(reviewViolations({ ...clean, ...migOk, [W]: direct }).some((x) => /legal/.test(x))).toBe(true);
    const viaLocal = "const stored = row.intake_answers;\nconst name = await loadCommunicationName(admin, studioId, clientId, stored);\nrecordPractitionerNotification({ title: 't', body: `${name} booked` });";
    expect(reviewViolations({ ...clean, ...migOk, [W]: viaLocal }).some((x) => /intake|answers/.test(x))).toBe(true);
    const member = "const name = await names.load(admin, studioId, clientId, row.clinical_notes);\nrecordPractitionerNotification({ title: 't', body: `${name} booked` });";
    expect(reviewViolations({ ...clean, ...migOk, [W]: member }).some((x) => /clinical|notes?/.test(x))).toBe(true);
  });

  it("7b3. ordinary arguments of an awaited call (ids, the admin client, the stored name) are not flagged", () => {
    const ok = "const name = await loadCommunicationName(admin, studio.id, clientId, clientName);\nrecordPractitionerNotification({ title: 't', body: `${name} booked` });";
    expect(reviewViolations({ ...clean, ...migOk, "app/book/[slug]/actions.ts": ok })).toEqual([]);
  });

  it("7c. a quoted-identifier insert into the table is discovered as an inserting migration", () => {
    const v = reviewViolations({ ...clean, ...migOk, "supabase/migrations/0998_q.sql": 'insert into "public"."practitioner_notifications" (title) values (\'x\');' });
    expect(v.some((x) => /migrations inserting/.test(x))).toBe(true);
  });

  it.each([
    ["concatenation", "do $$ begin execute 'insert into ' || 'practitioner_' || 'notifications' || ' (title) values (1)'; end $$;"],
    ["execute naming it", "do $$ begin execute format('insert into %I (title) values (1)', 'practitioner_notifications'); end $$;"],
  ])("7d. a migration that builds the table name or executes dynamic SQL naming it is flagged (%s)", (_n, sql) => {
    const v = reviewViolations({ ...clean, ...migOk, "supabase/migrations/0997_dyn.sql": sql });
    expect(v.some((x) => /dynamically/.test(x))).toBe(true);
  });

  it("a legal-identity read in a writer is flagged (condition b)", () => {
    const src = "import { readLegalIdentity } from '@/lib/clients/legal-identity';\nrecordPractitionerNotification({ body: 'x' });";
    expect(reviewViolations({ ...clean, ...migOk, "lib/billing/card-change-notification.ts": src }).some((x) => /legal identity read/.test(x))).toBe(true);
  });
});
