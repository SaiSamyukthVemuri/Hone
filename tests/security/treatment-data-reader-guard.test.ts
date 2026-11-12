import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { describe, expect, it } from "vitest";

// Roles R4 treatment-data reader guard (OPS, 3 Nov). THIS IS A TRIPWIRE, NOT A PROOF. See STATED_LIMITS at the bottom for what it cannot see.
//
// What it does, per data class:
//   records  tables -> clin.view_records   (sessions, blocks, areas, entries, plans, stages, clinical notes, imported memories)
//   intake   tables -> clin.view_intake    (client_intake_forms)
//   photos   tables -> clin.view_photos    (treatment_images)
// 1. DIRECT readers (Z3): a file that reads a protected table with .from("t"), with a table embedded in a select string, with a
//    template/constant table name behind a non-literal .from(x), or that calls an .rpc() whose migration body touches a protected table.
// 2. IMPORTERS (Z1): the import graph is computed. A name is "tainted" when its exported function body reads a protected table or calls a
//    tainted name imported from another file (fixed point). Every file that imports a tainted name must satisfy the same rule as a direct reader.
// 3. THE RULE (Z2): for each data class a file touches it must contain a REAL call, with comments stripped, requirePermission(..., "<key>")
//    or has_studio_permission with p_key "<key>" for THAT class's key, or be listed in ALLOW with a class and a reason.
//    A file that already contains the call for a class is "self-gated" for it: its exports no longer taint importers for that class.
// A new unclassified reader or importer fails here.
const RECORDS = ["sessions", "session_blocks", "session_block_areas", "electrolysis_entries", "laser_entries", "treatment_plans", "treatment_plan_stages", "client_clinical_notes", "imported_treatment_memories"];
const INTAKE = ["client_intake_forms"];
const PHOTOS = ["treatment_images"];
// aftercare: postcare send time and attempt counts live as COLUMNS on appointments, not in a table of their own, so the class is detected by
// column name inside a select string (a pseudo-table, "__postcare").
const AFTERCARE_COLUMNS = /postcare_email_sent_at|postcare_email_send_attempts/;
type DataClass = "records" | "intake" | "photos" | "aftercare";
const KEY: Record<DataClass, string> = { records: "clin.view_records", intake: "clin.view_intake", photos: "clin.view_photos", aftercare: "clin.view_aftercare" };
const CLASS_OF: Record<string, DataClass> = {
  ...Object.fromEntries(RECORDS.map((t) => [t, "records" as const])),
  ...Object.fromEntries(INTAKE.map((t) => [t, "intake" as const])),
  ...Object.fromEntries(PHOTOS.map((t) => [t, "photos" as const])),
  __postcare: "aftercare" as const,
};
const TABLES = Object.keys(CLASS_OF).filter((t) => t !== "__postcare");
const T_ALT = TABLES.join("|");
const DIRECT = new RegExp(`\\.from\\(\\s*["'\`](${T_ALT})["'\`]`, "g");
const EMBED = new RegExp(`(?<![\\w.])(?:\\w+:)?(${T_ALT})\\s*(?:!\\w+)?\\(`, "g");
const WORD = new RegExp(`\\b(${T_ALT})\\b`, "g");

type Cls = "owner-only" | "operator-only" | "write-path" | "system-side" | "attribution-only" | "status-only" | "billing-owner" | "caller-gated" | "covered-by-photos-gate";
// covers: which data classes this row accounts for (default: all). A mixed file lists only what it explains.
const ALLOW: Record<string, { cls: Cls; why: string; covers?: DataClass[] }> = {
  "app/(app)/settings/data/actions.ts": { cls: "owner-only", why: "owner data export; the owner holds every key" },
  "app/(app)/settings/data/page.tsx": { cls: "owner-only", why: "owner data export page" },
  "app/(app)/settings/import/actions.ts": { cls: "owner-only", why: "owner import of treatment memories (write)" },
  "app/admin/studios/[id]/page.tsx": { cls: "operator-only", why: "operator admin, not a studio role" },
  "app/(app)/clients/[id]/clinical-notes-actions.ts": { cls: "write-path", why: "add/revise note actions; clin.edit_records not wired yet, legacy checks stand" },
  "app/(app)/clients/[id]/treatment-plans-actions.ts": { cls: "write-path", why: "plan write actions" },
  "app/(app)/clients/[id]/intake/actions.ts": { cls: "write-path", why: "intake write actions (save, review, request update); clin.edit_intake not wired yet; no answers are returned to the caller" },
  "app/(app)/calendar/actions.ts": { cls: "write-path", why: "booking/lifecycle actions; ensureIntakeForClient creates the intake request row and sends the link, no answers are read or returned" },
  "app/(app)/clients/[id]/images/actions.ts": { cls: "write-path", why: "photo upload/archive actions resolve their own session; clin.view_photos gates the page" },
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts": { cls: "write-path", why: "session write actions" },
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts": { cls: "write-path", why: "block write actions" },
  "app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions.ts": { cls: "write-path", why: "copy write action" },
  "app/(app)/clients/[id]/sessions/[sessionId]/machine-setup-actions.ts": { cls: "write-path", why: "machine setup write action" },
  "app/(app)/clients/[id]/sessions/new/actions.ts": { cls: "write-path", why: "session create action" },
  "app/(app)/records/actions.ts": { cls: "write-path", why: "set_session_aftercare_explained write action" },
  "app/(app)/calendar/appointment-repair-actions.ts": { cls: "write-path", why: "appointment repair; the RPC returns a boolean about blocking dependents, no content" },
  "app/intake/[token]/actions.ts": { cls: "system-side", why: "the client's own tokened intake form" },
  "app/intake/[token]/page.tsx": { cls: "system-side", why: "the client's own tokened intake form" },
  "app/api/cron/appointment-reminders/route.ts": { cls: "system-side", why: "cron; reads intake status for reminders, no practitioner viewer" },
  "app/book/[slug]/actions.ts": { cls: "system-side", why: "public booking; creates the intake request, reads no answers for a viewer" },
  "app/portal/rebook-actions.ts": { cls: "system-side", why: "client portal, the client's own data" },
  "app/reschedule/[token]/actions.ts": { cls: "system-side", why: "client reschedule link, the client's own data" },
  "lib/portal/queries.ts": { cls: "system-side", why: "client portal, the client's own data" },
  "app/(app)/calendar/postcare-auto-send.ts": { cls: "write-path", why: "sends and claims postcare (messaging); reads the send columns only to avoid a re-send and returns a fixed outcome name, never a time or a count" },
  "lib/intake/write-revision.ts": { cls: "write-path", why: "write_intake_revision RPC (write)" },
  "lib/audit/governed-writes.ts": { cls: "write-path", why: "audit write RPC (write only, returns no content)" },
  "lib/billing/appointment-payment-state.ts": { cls: "billing-owner", why: "payment state is owner-only (HON-44)" },
  "lib/billing/authoritative-session-payment.ts": { cls: "billing-owner", why: "payment ledger path, owner-only" },
  "lib/billing/quick-checkout.ts": { cls: "billing-owner", why: "checkout is owner-only (HON-44)" },
  "lib/dashboard/unpaid-attention.ts": { cls: "billing-owner", why: "unpaid reminders read only price_paid_cents and settlement amounts, for the OWNER (viewerIsOwner is passed true; the gate is default OFF); no treatment content is read" },
  "lib/billing/session-payment-eligibility.ts": { cls: "billing-owner", why: "payment eligibility, owner-only" },
  "lib/billing/session-payment-charge.ts": { cls: "billing-owner", why: "claim_session_payment_charge_attempt RPC, payment path, owner-only" },
  "lib/billing/payment-refund.ts": { cls: "billing-owner", why: "reconcile_bound_payment_event RPC, payment path" },
  "lib/dashboard/missing-records-assistant.ts": { cls: "status-only", why: "intake read is client id, status and created_at only; its records reads are gated in the loader", covers: ["intake"] },
  "app/(app)/clients/[id]/edit/page.tsx": { cls: "caller-gated", why: "calls getClientById with includeSessions:false, so no sessions or notes are read (asserted below)", covers: ["records"] },
  "lib/billing/payment-webhook-reconciliation.ts": { cls: "system-side", why: "payment webhook reconciliation, no viewer" },
  "app/(app)/calendar/page.tsx": { cls: "attribution-only", why: "imports the solo-owner review-link check, which reads only who performed a visit and which appointment (sessions.performed_by_practitioner_id, appointment_id); no treatment content is read or rendered", covers: ["records"] },
  "app/(app)/settings/team/page.tsx": { cls: "attribution-only", why: "imports the solo-owner review-link check, which reads only who performed a visit and which appointment (sessions.performed_by_practitioner_id, appointment_id); no treatment content is read or rendered", covers: ["records"] },
  "app/(app)/calendar/check-practitioner/page.tsx": { cls: "attribution-only", why: "reads only who performed a visit (performed_by_practitioner_id), no treatment content" },
  "lib/sessions/session-lineage.ts": { cls: "write-path", why: "asserts a session belongs to a client before a write; returns no data" },
  "lib/dashboard/intakes-awaiting-review.ts": { cls: "status-only", why: "client id, status and created_at only; never answers" },
  "lib/clients/directory-read.ts": { cls: "status-only", why: "client id, status and created_at only; never answers" },
  "app/(app)/dashboard/page.tsx": { cls: "status-only", why: "intake STATUS per client for the roster pills (never answers); the records reads on this page are gated", covers: ["intake"] },
  "app/(app)/clients/[id]/images/page.tsx": { cls: "covered-by-photos-gate", why: "the sessions read only groups photos by session and sits behind the clin.view_photos gate (OPS decision)", covers: ["records"] },
  "app/(app)/clients/[id]/sessions/[sessionId]/session-photos.ts": { cls: "covered-by-photos-gate", why: "block embed only to group photos; behind the clin.view_photos gate", covers: ["records"] },
  // Loaders that take no studio to ask with, or that are shared with system paths. Their IMPORTERS are computed from the import graph and must each ask.
  "lib/intake/queries.ts": { cls: "caller-gated", why: "loaders shared with system paths (booking, reminders, portal) that have no practitioner viewer; importers are checked from the import graph" },
  "lib/clinical-notes/queries.ts": { cls: "caller-gated", why: "loaders take a client id only (no studio to ask with); importers are checked from the import graph" },
  "lib/clinical-notes/section-data.ts": { cls: "caller-gated", why: "wraps the clinical-notes loaders; importers are checked from the import graph" },
  "lib/supabase/queries.ts": { cls: "caller-gated", why: "client and session loaders; importers are checked from the import graph" },
  "lib/machines/machine-queries.ts": { cls: "caller-gated", why: "machine registry and recorded setups; importers are checked from the import graph" },
};
// Rows for files that exist on the base branch but not on every stack of this program (the Roles branches are cut from an older base).
// Applied only when the file is present AND reads a protected table, so the stale-row check below still holds for everything else and a base
// merge cannot go red on a file version this branch has never seen.
const ALLOW_WHEN_PRESENT: Record<string, { cls: Cls; why: string; covers?: DataClass[] }> = {
  "app/(app)/calendar/check-practitioner/actions.ts": {
    cls: "owner-only",
    why: "reassignOpenAppointmentAction refuses unless the caller is the active studio owner (practitioner.role === 'owner'); it counts live sessions linked to the appointment (head count, exists-or-not) to refuse a reassignment and returns only fixed copy, never a row. The owner holds every key.",
  },
};
// ...and only while that file actually reads a protected table (an older copy of the file on this branch does not, so it needs no row).
for (const [f, row] of Object.entries(ALLOW_WHEN_PRESENT)) if (existsSync(f) && /\.from\(\s*["']sessions["']/.test(readFileSync(f, "utf8"))) ALLOW[f] = row;

// ---------------------------------------------------------------------------------------------------------------------------------
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
const FILES = ["app", "lib", "components"].flatMap(walk);
const SRC = new Map(FILES.map((f) => [f, strip(readFileSync(f, "utf8"))]));

const hasCall = (src: string, key: string) =>
  new RegExp(`requirePermission\\s*\\([\\s\\S]{0,300}?["']${key.replace(".", "\\.")}["']`).test(src) ||
  new RegExp(`has_studio_permission[\\s\\S]{0,200}?p_key\\s*:\\s*["']${key.replace(".", "\\.")}["']`).test(src);
const selfGated = (f: string, c: DataClass) => hasCall(SRC.get(f)!, KEY[c]);

function tablesIn(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(DIRECT)) out.add(m[1]!);
  for (const m of src.matchAll(/\.select\(\s*([`"'])((?:\\.|(?!\1).)*)\1/gs)) {
    for (const e of m[2]!.matchAll(EMBED)) out.add(e[1]!);
    if (AFTERCARE_COLUMNS.test(m[2]!)) out.add("__postcare");
  }
  // a select list built with a conditional or a constant: any quoted column LIST that names the columns
  if (/["'`][^"'`\n]*\b(?:postcare_email_sent_at|postcare_email_send_attempts)\b[^"'`\n]*,[^"'`\n]*["'`]|["'`][^"'`\n]*,[^"'`\n]*\b(?:postcare_email_sent_at|postcare_email_send_attempts)\b[^"'`\n]*["'`]/.test(src)) out.add("__postcare");
  // Z3: a constant or template table name behind a non-literal .from(x)
  if (/(?<!Array|Buffer|Object)\.from\(\s*(?!"|'|`)[^)\s]/.test(src)) for (const w of src.matchAll(WORD)) out.add(w[1]!);
  return out;
}

// RPCs (Z3): functions in migrations whose body touches a protected table, called through .rpc("name")
const RPC_CLASS = new Map<string, Set<DataClass>>();
for (const m of readdirSync("supabase/migrations").filter((n) => n.endsWith(".sql")).sort()) {
  const s = readFileSync(join("supabase/migrations", m), "utf8");
  for (const f of s.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.(\w+)\s*\(([\s\S]*?)\$(\w*)\$([\s\S]*?)\$\3\$/gi)) {
    if (/returns\s+trigger/i.test(f[0].slice(0, f[0].indexOf("$")))) continue;
    const classes = new Set<DataClass>();
    for (const w of f[4]!.matchAll(WORD)) classes.add(CLASS_OF[w[1]!]!);
    if (classes.size) RPC_CLASS.set(f[1]!, new Set([...(RPC_CLASS.get(f[1]!) ?? []), ...classes]));
  }
}
function rpcClasses(src: string): Set<DataClass> {
  const out = new Set<DataClass>();
  for (const m of src.matchAll(/\.rpc\(\s*["'](\w+)["']/g)) for (const c of RPC_CLASS.get(m[1]!) ?? []) out.add(c);
  return out;
}

// direct classes per file
const DIRECT_CLASSES = new Map<string, Set<DataClass>>();
for (const [f, src] of SRC) {
  const cs = new Set<DataClass>();
  for (const t of tablesIn(src)) cs.add(CLASS_OF[t]!);
  for (const c of rpcClasses(src)) cs.add(c);
  if (cs.size) DIRECT_CLASSES.set(f, cs);
}

// import graph (Z1)
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = spec.slice(2);
  else if (spec.startsWith(".")) base = normalize(join(dirname(from), spec));
  else return null;
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) if (SRC.has(cand)) return cand;
  return null;
}
type Imp = { file: string; names: string[] };
const IMPORTS = new Map<string, Imp[]>();
for (const [f, src] of SRC) {
  const list: Imp[] = [];
  for (const m of src.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[\w*]+\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+["']([^"']+)["']/g)) {
    const target = resolve(f, m[4]!);
    if (!target) continue;
    const names = m[1] ? m[1].split(",").map((x) => x.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean) : ["*"];
    list.push({ file: target, names });
  }
  IMPORTS.set(f, list);
}
function exportsOf(src: string): Array<{ name: string; body: string }> {
  const marks = [...src.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=|class\s+(\w+))/g)];
  return marks.map((m, i) => ({ name: m[1] ?? m[2] ?? m[3] ?? "default", body: src.slice(m.index!, marks[i + 1]?.index ?? src.length) }));
}
const TERMINAL = (f: string) => f.startsWith("app/") || f.startsWith("components/");

// tainted exported names per file -> data classes
const TAINT = new Map<string, Map<string, Set<DataClass>>>();
function addTaint(f: string, name: string, cs: Iterable<DataClass>): boolean {
  const m = TAINT.get(f) ?? new Map<string, Set<DataClass>>();
  TAINT.set(f, m);
  const cur = m.get(name) ?? new Set<DataClass>();
  const before = cur.size;
  const row = ALLOW[f];
  for (const c of cs) {
    if (selfGated(f, c)) continue;
    // A file classed as something other than caller-gated has accounted for itself; it does not pass the duty to importers.
    if (row && row.cls !== "caller-gated" && (!row.covers || row.covers.includes(c))) continue;
    cur.add(c);
  }
  m.set(name, cur);
  return cur.size > before;
}
for (const [f, src] of SRC) {
  if (TERMINAL(f)) continue;
  for (const ex of exportsOf(src)) {
    const cs = new Set<DataClass>();
    for (const t of tablesIn(ex.body)) cs.add(CLASS_OF[t]!);
    for (const c of rpcClasses(ex.body)) cs.add(c);
    if (cs.size) addTaint(f, ex.name, cs);
  }
}
for (let round = 0; round < 8; round++) {
  let changed = false;
  for (const [f, src] of SRC) {
    if (TERMINAL(f)) continue;
    const imps = IMPORTS.get(f) ?? [];
    for (const ex of exportsOf(src)) {
      for (const imp of imps) {
        const tm = TAINT.get(imp.file);
        if (!tm) continue;
        for (const [n, cs] of tm) {
          if (cs.size === 0) continue;
          const used = imp.names.includes(n) || imp.names.includes("*");
          if (used && new RegExp(`\\b${n}\\b`).test(ex.body)) changed = addTaint(f, ex.name, cs) || changed;
        }
      }
    }
  }
  if (!changed) break;
}
// classes a file needs because of what it imports
function importedClasses(f: string): Map<DataClass, string[]> {
  const out = new Map<DataClass, string[]>();
  for (const imp of IMPORTS.get(f) ?? []) {
    if (imp.file === f) continue;
    const tm = TAINT.get(imp.file);
    if (!tm) continue;
    for (const [n, cs] of tm) {
      if (!(imp.names.includes(n) || imp.names.includes("*"))) continue;
      if (imp.names.includes("*") === false && !new RegExp(`\\b${n}\\b`).test(SRC.get(f)!)) continue;
      for (const c of cs) out.set(c, [...(out.get(c) ?? []), `${n} (${imp.file})`]);
    }
  }
  return out;
}

// What each file must account for, and what is missing.
function missing(f: string): Array<{ cls: DataClass; via: string }> {
  const need = new Map<DataClass, string>();
  for (const c of DIRECT_CLASSES.get(f) ?? []) need.set(c, "reads it directly");
  for (const [c, via] of importedClasses(f)) if (!need.has(c)) need.set(c, `imports ${via.slice(0, 3).join(", ")}`);
  const row = ALLOW[f];
  const out: Array<{ cls: DataClass; via: string }> = [];
  for (const [c, via] of need) {
    if (selfGated(f, c)) continue;
    if (row && (!row.covers || row.covers.includes(c))) continue;
    // A lib wrapper (non-terminal) with tainted exports passes the obligation to its own importers instead.
    if (!TERMINAL(f) && TAINT.get(f) && [...TAINT.get(f)!.values()].some((s) => s.has(c))) continue;
    out.push({ cls: c, via });
  }
  return out;
}

const touching = FILES.filter((f) => DIRECT_CLASSES.has(f) || importedClasses(f).size > 0);

describe("treatment-data reader guard (a tripwire, not a proof)", () => {
  it("the scan is alive: it finds readers, the import graph resolves, and RPC bodies are parsed", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect([...DIRECT_CLASSES.keys()].length).toBeGreaterThan(30);
    expect(touching.length).toBeGreaterThan([...DIRECT_CLASSES.keys()].length);
    expect(RPC_CLASS.size).toBeGreaterThan(30);
    expect(TAINT.get("lib/intake/queries.ts")?.size ?? 0).toBeGreaterThan(3);
  });

  it("Z1/Z2/Z3: every direct reader and every importer of a tainted loader makes the KEY-SPECIFIC call or is classified", () => {
    const bad: string[] = [];
    for (const f of touching) for (const m of missing(f)) bad.push(`${f}: needs a requirePermission call for ${KEY[m.cls]} (${m.via})`);
    expect(bad, `ungated, unclassified readers/importers:\n${bad.join("\n")}`).toEqual([]);
  });

  it("a key named only in a comment or a string does not count (comments are stripped, a real call is required)", () => {
    expect(hasCall(strip('// requirePermission(db, s, "clin.view_records")\nconst x = 1;'), "clin.view_records")).toBe(false);
    expect(hasCall(strip('/* requirePermission(db, s, "clin.view_records") */ const k = "clin.view_records";'), "clin.view_records")).toBe(false);
    expect(hasCall('await requirePermission(supabase, studio.id, "clin.view_records", { client: id })', "clin.view_records")).toBe(true);
    // key-specific: the records key does not satisfy an intake reader
    expect(hasCall('await requirePermission(db, s, "clin.view_records")', "clin.view_intake")).toBe(false);
  });

  it("no stale allow-list row: each names an existing file that still touches protected data", () => {
    for (const f of Object.keys(ALLOW)) {
      expect(existsSync(f), `${f} no longer exists`).toBe(true);
      expect(touching.includes(f) || (TAINT.get(f)?.size ?? 0) > 0, `${f} no longer touches protected data; remove its row`).toBe(true);
    }
  });

  it("the aftercare class is live: the timeline loader reads the postcare columns and its page asks clin.view_aftercare", () => {
    expect(DIRECT_CLASSES.get("lib/supabase/queries.ts")?.has("aftercare")).toBe(true);
    expect(selfGated("app/(app)/clients/[id]/page.tsx", "aftercare")).toBe(true);
    // every file that reads the columns is either self-gated for aftercare or classified; the main rule test enforces it, this pins the page that reads them most
    expect(selfGated("app/(app)/calendar/[id]/page.tsx", "aftercare")).toBe(true);
  });

  it("the edit page really opts out of session reads", () => {
    expect(SRC.get("app/(app)/clients/[id]/edit/page.tsx")).toMatch(/getClientById\([^)]*includeSessions:\s*false/);
  });

  it("every allow-list row states a reason", () => {
    for (const [f, row] of Object.entries(ALLOW)) expect(row.why.length, f).toBeGreaterThan(15);
  });

  it("the lists of what the scan cannot see are stated (Z4)", () => {
    expect(STATED_LIMITS.length).toBeGreaterThanOrEqual(8);
  });
});

// Server actions (OPS, 3 Nov, Codex at 48133681f): a "use server" export is callable from an already-open tab after a key is revoked, so
// a file-level "write-path" class does NOT excuse an action that RETURNS treatment data. Every exported action whose body touches a
// protected class (directly, by RPC, or through a tainted loader) must make the key call INSIDE that function, or be listed here by name
// as returning no table data.
const isUseServer = (src: string) => /^\s*["']use server["']/.test(src);
function actionClasses(f: string, body: string): Map<DataClass, string> {
  const out = new Map<DataClass, string>();
  for (const t of tablesIn(body)) out.set(CLASS_OF[t]!, `reads ${t}`);
  for (const c of rpcClasses(body)) if (!out.has(c)) out.set(c, "calls an rpc over it");
  for (const imp of IMPORTS.get(f) ?? []) {
    for (const [n, cs] of TAINT.get(imp.file) ?? []) {
      if (!(imp.names.includes(n) || imp.names.includes("*")) || !new RegExp(`\\b${n}\\b`).test(body)) continue;
      for (const c of cs) if (!out.has(c)) out.set(c, `uses ${n}`);
    }
  }
  return out;
}
// Files with no practitioner viewer in the loop: token links and the client's own portal, owner-only and operator-only pages, payment owner paths.
const EXEMPT_ACTION_CLASSES = new Set(["system-side", "owner-only", "operator-only", "billing-owner"]);
const ACTIONS_NO_DATA: Record<string, string> = {
  "app/(app)/calendar/actions.ts::sendPostcareEmailAction": "sends postcare (messaging, not viewing); reads the send columns to refuse a duplicate and returns only ok/error with fixed copy, never a time or a count",
  "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts::removeSessionAreaAction": "chart edit gated on clin.view_records; the photos class is only the count of block-scoped images it voids (entriesRemoved/imagesRemoved), no image or path is returned",
  "app/(app)/calendar/actions.ts::bookAppointmentForClientAction": "returns the new appointment id; ensureIntakeForClient only creates the intake request row and link, no answers are read or returned",
  "app/(app)/calendar/actions.ts::fetchLastServiceForClientAction": "returns the last service name from appointments, not chart data; the intake name matched belongs to a helper after it",
  // "<file>::<exportName>": reason it returns no table data
  "app/(app)/calendar/appointment-repair-actions.ts::loadAppointmentRepairStateAction": "returns repairable true/false and a fixed reason, no chart content",
  "app/(app)/clients/[id]/images/actions.ts::uploadTreatmentImageAction": "returns only ok/error; the photo signing path asks clin.view_photos",
  "app/(app)/clients/[id]/images/actions.ts::updateTreatmentImageNoteAction": "returns only ok/error; the photo signing path asks clin.view_photos",
  "app/(app)/clients/[id]/images/actions.ts::archiveTreatmentImageAction": "returns only ok/error; the photo signing path asks clin.view_photos",
  "app/(app)/clients/[id]/intake/actions.ts::requestIntakeUpdateAction": "returns only ok/error or a link state; writes status or sends the link, returns no answers",
  "app/(app)/clients/[id]/intake/actions.ts::resendIntakeEmailAction": "returns only ok/error or a link state; writes status or sends the link, returns no answers",
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts::updateSessionPriceAction": "RESIDUAL: a PRICING action (appointment price), not clinical record editing; stays under the pricing keys (not_yet). Returns only ok/error",
  "app/(app)/clients/[id]/sessions/new/actions.ts::startSessionAction": "redirects to the new chart; returns no data",
  "app/(app)/records/actions.ts::markAftercareExplainedAction": "write action; returns only ok/error",
};
const RAW_SRC = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));
// RU-1 (Insurance): an action that calls a same-file helper which reads a protected table reads it too. Functions are cut at every
// top-level function/const-arrow marker (exported or not), and an action's scan includes the bodies of same-file functions it calls,
// followed transitively within the file. Cross-file helpers are covered by the import-graph taint above.
type Fn = { name: string; exported: boolean; body: string };
function functionsOf(src: string): Fn[] {
  const marks = [...src.matchAll(/^(export\s+)?(?:async\s+)?function\s+(\w+)|^(export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/gm)];
  return marks.map((m, i) => ({
    name: (m[2] ?? m[4])!,
    exported: Boolean(m[1] || m[3]),
    body: src.slice(m.index!, marks[i + 1]?.index ?? src.length),
  }));
}
function withLocalHelpers(fns: Fn[], fn: Fn): string {
  const seen = new Set([fn.name]);
  let text = fn.body;
  for (let grew = true; grew; ) {
    grew = false;
    for (const h of fns) {
      if (h.exported || seen.has(h.name)) continue;
      if (new RegExp(`\\b${h.name}\\s*[(<]`).test(text)) {
        seen.add(h.name);
        text += "\n" + h.body;
        grew = true;
      }
    }
  }
  return text;
}
const ACTION_FINDINGS: string[] = [];
for (const [f, raw] of RAW_SRC) {
  if (!isUseServer(raw)) continue;
  if (EXEMPT_ACTION_CLASSES.has(ALLOW[f]?.cls ?? "")) continue;
  const fns = functionsOf(SRC.get(f)!);
  for (const fn of fns) {
    if (!fn.exported || !/^export\s+async\s+function/.test(fn.body)) continue;
    const scope = withLocalHelpers(fns, fn);
    for (const [c, why] of actionClasses(f, scope)) {
      // the key call must be in the action itself or in a same-file helper it calls
      if (hasCall(scope, KEY[c])) continue;
      if (ACTIONS_NO_DATA[`${f}::${fn.name}`]) continue;
      ACTION_FINDINGS.push(`${f}::${fn.name} ${why} (${c}) without a ${KEY[c]} call inside the action`);
    }
  }
}

describe("server actions that touch treatment data ask the key themselves (open-tab replay)", () => {
  it("every exported server action touching a protected class makes the key call inside itself or is listed as returning no table data", () => {
    expect(ACTION_FINDINGS, ACTION_FINDINGS.join("\n")).toEqual([]);
  });
  it("each no-data listing names a real action with a reason", () => {
    for (const [k, why] of Object.entries(ACTIONS_NO_DATA)) {
      const [f, n] = k.split("::");
      expect(RAW_SRC.get(f!)?.includes(`export async function ${n}`), `${k} does not exist`).toBe(true);
      expect(why.length, k).toBeGreaterThan(15);
    }
  });
  it("the scan sees the known reader: getWholeSessionCopySourceAction counts as a reader", () => {
    const f = "app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions.ts";
    const fns = functionsOf(strip(readFileSync(f, "utf8")).replace(/requirePermission\s*\([^;]*;/g, ""));
    const fn = fns.find((e) => e.name === "getWholeSessionCopySourceAction")!;
    expect(actionClasses(f, withLocalHelpers(fns, fn)).has("records")).toBe(true);
  });

  it("a same-file helper that reads a protected table makes its caller a reader (RU-1)", () => {
    const src = strip(`"use server";
export async function act() { return load(); }
async function load() { return db.from("client_intake_forms").select("*"); }`);
    const fns = functionsOf(src);
    const scope = withLocalHelpers(fns, fns.find((x) => x.name === "act")!);
    expect(actionClasses("lib/none.ts", scope).get("intake")).toMatch(/reads/);
    // control: no helper call, no finding
    const lone = functionsOf(strip(`"use server";
export async function act() { return 1; }
async function load() { return db.from("client_intake_forms").select("*"); }`));
    expect(actionClasses("lib/none.ts", withLocalHelpers(lone, lone.find((x) => x.name === "act")!)).size).toBe(0);
  });
});

// Z4. STATED LIMITS: what this guard does NOT see. It is a tripwire for the common shapes of a new reader, not proof that no path reads
// treatment data without a check.
export const STATED_LIMITS = [
  "FILE-LEVEL, NOT PATH-LEVEL: a key call anywhere in a file satisfies the file. It does not prove the call precedes the read, covers every branch, or that the result is honoured.",
  "Names of tables built at runtime from user input, config or concatenation are not seen; only quoted literals, embedded select strings, and template/constant names in a file that also has a non-literal .from(x) are.",
  "Views and functions that are not in supabase/migrations (hosted-only objects) are unknown; no view over a protected table exists in the migrations today. RPC bodies are matched by table name, so a function that reaches the data through another function or a view is not seen.",
  "Import resolution handles static import/export-from of project paths (@/ and relative); dynamic import(), require() and re-export barrels with renamed bindings are not followed.",
  "Same-file helper following is by name and transitive within one file; a helper reached through an object, a callback or a variable alias is not followed, and a key call in a helper counts for every action that calls that helper.",
  "Taint is by exported name and by identifier match inside an exported function body; reads reached through a callback, a class method or a value passed as an argument are not followed.",
  "Reads outside app/, lib/ and components/ (scripts, edge functions, supabase/functions, cron outside app/api) are not scanned.",
  "Storage objects and signed URLs for treatment images are covered only through the treatment_images table and the signing-site test in tests/lib/permissions/enforcement-wiring.test.ts.",
  "Row Level Security and database-side checks are out of scope; this guard only reads application source. DB behaviour is proven by the DB tests, which need the heavy slot.",
  "A file classed owner-only, system-side, write-path, billing-owner or status-only is trusted on its stated reason; the guard checks the reason exists, not that it is true.",
] as const;
