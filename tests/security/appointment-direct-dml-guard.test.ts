import { describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  adminModuleImports,
  describeSites,
  runtimeSourceFiles,
  supabaseWriteSites,
  type WriteSite,
} from "./helpers/supabase-write-census";

// ===========================================================================
// Appointment boundary PR B1 — static direct-DML census guard.
// ===========================================================================
//
// WHY THIS EXISTS. `docs/audits/APPOINTMENT_DML_BOUNDARY_2026-08.md` found that
// `public.appointments` has never received a GRANT or REVOKE in any of the 170
// migrations, so `authenticated` still holds INSERT/UPDATE/DELETE under the
// 0010 `appointments_member_all` FOR ALL policy. The audit's central claim —
// and the reason the future revoke (PR B3, migration 0172) is a
// ZERO-APPLICATION-CHANGE migration — is this:
//
//     Every appointment write in shipped code goes through a reviewed
//     service_role-only SECURITY DEFINER command, EXCEPT seven direct
//     PostgREST UPDATEs that touch only `postcare_email_*` bookkeeping
//     columns and all run as service_role under a server-resolved studio_id.
//
// That claim is true at this commit and nothing enforces it. This guard is the
// enforcement. It runs BEFORE the migration deliberately: a census that ships
// last never froze the writers while the migration was being written.
//
// WHAT THIS GUARD DOES NOT PROVE. It is static. It cannot detect a write issued
// by a browser holding a valid JWT straight against PostgREST — that is exactly
// what the revoke closes, and no test in this tree can substitute for it. This
// guard proves only that the APPLICATION does not need the privilege.
//
// ANALYZER CHOICE. It uses `supabaseWriteSites()` from
// `tests/security/helpers/supabase-write-census.ts` — the TypeScript
// compiler-API census that walks app/, lib/, components/, scripts/ and
// middleware.ts, resolves table expressions and DML payloads through same-scope
// bindings, and FAILS CLOSED on anything it cannot follow. It deliberately does
// NOT use the bracket-walking `directWriteSites()` local to
// `entry-direct-dml-guard.test.ts`: that one matches by text proximity and
// would miss an aliased receiver, a multi-line chain, or a variable table.

const APPOINTMENTS = "appointments";
const APPOINTMENT_AUDIT = "appointment_audit";
const TABLES = [APPOINTMENTS, APPOINTMENT_AUDIT] as const;
type ApptTable = (typeof TABLES)[number];

const REPO_ROOT = join(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// The frozen writer set.
// ---------------------------------------------------------------------------
//
// Identified by repository-relative file + enclosing function + operation +
// resolved table + resolved payload columns. NEVER by line number: line numbers
// drift on every edit above them, and a guard that drifts gets "fixed" by
// bumping the number rather than by reading the diff.
//
// Two sites in `sendPostcareEmailAction` share an identical descriptor (the
// first-send claim and the resend claim write the same three columns), so this
// is compared as a MULTISET, not a set. That is what makes the count
// load-bearing: deleting one of the two, or adding a third, fails.

type Descriptor = {
  file: string;
  fn: string;
  op: WriteSite["op"];
  table: ApptTable;
  columns: string[];
};

const CLAIM_COLUMNS = [
  "postcare_email_claimed_at",
  "postcare_email_last_attempt_at",
  "postcare_email_send_attempts",
];
const FAILURE_COLUMNS = [
  "postcare_email_failed_at",
  "postcare_email_last_error",
  "postcare_email_claimed_at",
];
const SUCCESS_COLUMNS = [
  "postcare_email_sent_at",
  "postcare_email_failed_at",
  "postcare_email_last_error",
  "postcare_email_claimed_at",
];

const MANUAL = "app/(app)/calendar/actions.ts";
const AUTO = "app/(app)/calendar/postcare-auto-send.ts";

// B8 / 0177 — THE EXCEPTION IS CLOSED. This list previously held the seven
// direct postcare writers B5/0174 deliberately allowed while the boundary was
// being built (four in sendPostcareEmailAction, three in
// autoSendPostcareOnComplete). 0177 replaced them with claim_postcare_send and
// settle_postcare_send and revoked service_role's column-level UPDATE, so there
// is no longer any reviewed direct writer at all.
//
// Adding an entry here is now a deliberate re-opening of a closed boundary and
// requires the same scrutiny the original exception got.
const ALLOWED: ReadonlyArray<Descriptor & { why: string }> = [];


/**
 * Every column the postcare bookkeeping family owns. Pinned from the migration
 * tree: `rg -oh 'postcare_email_[a-z_]+' supabase/migrations/*.sql | sort -u`
 * returns exactly these six, and every one is nullable metadata that carries no
 * scheduling, clinical, tenancy or money meaning.
 */
const POSTCARE_BOOKKEEPING_COLUMNS = new Set([
  "postcare_email_claimed_at",
  "postcare_email_failed_at",
  "postcare_email_last_attempt_at",
  "postcare_email_last_error",
  "postcare_email_send_attempts",
  "postcare_email_sent_at",
]);

/**
 * Columns whose appearance in a direct write would mean the application had
 * started bypassing a reviewed command. Redundant with the subset assertion
 * above — deliberately, because this list is what makes the failure message
 * name the actual danger instead of "set mismatch".
 */
const FORBIDDEN_COLUMNS = [
  "status",
  "starts_at",
  "ends_at",
  "duration_minutes",
  "practitioner_id",
  "client_id",
  "service_id",
  "studio_id",
  "booked_outside_availability",
  "capacity_enabled",
  "cancellation_token_hash",
  "cancelled_at",
  "cancelled_by",
  "cancellation_reason",
  "cancellation_kind",
  "rescheduled_from_appointment_id",
  "rescheduled_to_appointment_id",
  "sync_version",
  "blocked_ends_at",
  "buffer_minutes_snapshot",
] as const;

// ---------------------------------------------------------------------------
// Receiver resolution for UPDATE chains.
// ---------------------------------------------------------------------------
//
// `insertReceiverProof()` in the shared helper resolves `.insert(...)` chains
// only, and all seven writers here are `.update(...)`. Rather than widen a
// shared test harness (which other guards depend on), the equivalent walk lives
// here. It is SCOPE-AWARE, which the shared helper's file-wide `resolveBinding`
// is not: `app/(app)/calendar/actions.ts` declares `const admin =
// createAdminClient()` in four different functions, so a file-wide lookup finds
// four hits and gives up.

type Binding =
  | { kind: "admin-factory"; callee: string }
  | { kind: "authenticated-factory"; callee: string }
  | { kind: "injected-dependency"; text: string }
  | { kind: "unknown"; text: string };

type SiteReceiver = {
  file: string;
  fn: string;
  line: number;
  op: string;
  receiver: string | null;
  bindings: Binding[];
};

function parse(relFile: string): ts.SourceFile {
  const full = join(REPO_ROOT, relFile);
  return ts.createSourceFile(
    full,
    readFileSync(full, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    relFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Strip `await`, `as X`, `satisfies X`, `(...)` and non-null `!`. */
function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isAwaitExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** Where a local binding name actually came from. */
type Origin = { exported: string; from: string };

const ADMIN_MODULE = /admin|service[-_]?role/i;

/**
 * Map every locally-bound factory name to the module and EXPORTED name it came
 * from — covering both static `import { a as b } from "m"` and the dynamic
 * `const { a: b } = await import("m")` form this codebase uses inside server
 * actions.
 *
 * This exists because classifying on the CALLEE NAME is trivially evadable, and
 * the evasion was demonstrated against an earlier draft of this guard:
 *
 *     const { createClient: createAdminClient } = await import("@/lib/supabase/server");
 *     const admin = await createAdminClient();
 *
 * Every write then runs on the AUTHENTICATED client while a name-matching guard
 * reports service-role. `supabase-write-census.ts:499-505` records the same
 * evasion in the opposite direction. Origin, not name, is the property.
 */
function factoryOrigins(sf: ts.SourceFile): Map<string, Origin> {
  const map = new Map<string, Origin>();
  const visit = (n: ts.Node) => {
    // Static: import { createAdminClient as x } from "…"
    if (
      ts.isImportDeclaration(n) &&
      ts.isStringLiteral(n.moduleSpecifier) &&
      n.importClause?.namedBindings &&
      ts.isNamedImports(n.importClause.namedBindings)
    ) {
      const from = n.moduleSpecifier.text;
      for (const el of n.importClause.namedBindings.elements) {
        map.set(el.name.text, { exported: el.propertyName?.text ?? el.name.text, from });
      }
    }
    // Dynamic: const { createAdminClient: x } = await import("…")
    if (
      ts.isVariableDeclaration(n) &&
      ts.isObjectBindingPattern(n.name) &&
      n.initializer
    ) {
      const init = unwrap(n.initializer);
      if (
        ts.isCallExpression(init) &&
        init.expression.kind === ts.SyntaxKind.ImportKeyword &&
        init.arguments[0] &&
        ts.isStringLiteral(init.arguments[0])
      ) {
        const from = (init.arguments[0] as ts.StringLiteral).text;
        for (const el of n.name.elements) {
          if (!ts.isIdentifier(el.name)) continue;
          const exported =
            el.propertyName && ts.isIdentifier(el.propertyName)
              ? el.propertyName.text
              : el.name.text;
          map.set(el.name.text, { exported, from });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

function classify(expr: ts.Expression, sf: ts.SourceFile): Binding {
  const e = unwrap(expr);
  if (ts.isCallExpression(e)) {
    const callee = ts.isIdentifier(e.expression)
      ? e.expression.text
      : e.expression.getText(sf);
    const origin = factoryOrigins(sf).get(callee);
    // Unknown provenance is NOT admin. A factory this walk cannot trace back to
    // an import — a locally defined wrapper, a re-export, a parameter — leaves
    // the privilege level unproven, and unproven fails.
    if (!origin) return { kind: "unknown", text: `${callee}() — unresolved origin` };
    const isAdmin = ADMIN_MODULE.test(origin.from) && origin.exported === "createAdminClient";
    if (isAdmin) return { kind: "admin-factory", callee: `${origin.exported}@${origin.from}` };
    return {
      kind: "authenticated-factory",
      callee: `${origin.exported}@${origin.from}`,
    };
  }
  // `deps?.admin` / `deps.admin` — the test-injection seam. Acceptable ONLY
  // alongside a real admin factory binding in the same scope; asserted below.
  if (
    (ts.isPropertyAccessExpression(e) || ts.isPropertyAccessChain(e)) &&
    ts.isIdentifier(e.name) &&
    /^(admin|adminClient)$/.test(e.name.text)
  ) {
    return { kind: "injected-dependency", text: e.getText(sf).slice(0, 80) };
  }
  return { kind: "unknown", text: e.getText(sf).slice(0, 80) };
}

/** Nearest enclosing function-ish node, so binding lookup is scoped. */
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) ||
      ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) ||
      ts.isMethodDeclaration(cur)
    ) {
      return cur;
    }
    cur = cur.parent;
  }
  return undefined;
}

function enclosingName(node: ts.Node): string {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    if (
      (ts.isArrowFunction(cur) || ts.isFunctionExpression(cur)) &&
      cur.parent &&
      ts.isVariableDeclaration(cur.parent) &&
      ts.isIdentifier(cur.parent.name)
    ) {
      return cur.parent.name.text;
    }
    cur = cur.parent;
  }
  return "(top-level)";
}

/**
 * Every DML chain in `relFile` whose `.from(...)` names one of `tables`, with
 * the receiver identifier resolved and every binding of that identifier — both
 * declarations and re-assignments — classified, within the nearest enclosing
 * function (falling back to the whole file when the site is top-level).
 */
function receiverProofs(relFile: string, tables: readonly string[]): SiteReceiver[] {
  const sf = parse(relFile);
  const DML = new Set(["insert", "update", "upsert", "delete"]);
  const out: SiteReceiver[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      DML.has(node.expression.name.text)
    ) {
      const op = node.expression.name.text;
      let cur: ts.Node = node.expression.expression;
      let receiverExpr: ts.Expression | null = null;
      let matched = false;
      while (cur) {
        if (
          ts.isCallExpression(cur) &&
          ts.isPropertyAccessExpression(cur.expression) &&
          cur.expression.name.text === "from"
        ) {
          const arg = cur.arguments[0];
          if (
            arg &&
            (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
            tables.includes(arg.text)
          ) {
            matched = true;
            receiverExpr = cur.expression.expression;
          }
          break;
        }
        if (ts.isCallExpression(cur) || ts.isPropertyAccessExpression(cur)) {
          cur = cur.expression;
          continue;
        }
        break;
      }

      if (matched) {
        const receiver =
          receiverExpr && ts.isIdentifier(receiverExpr) ? receiverExpr.text : null;
        const scope = enclosingFunction(node) ?? sf;
        const bindings: Binding[] = [];
        if (receiver) {
          const collect = (n: ts.Node) => {
            if (
              ts.isVariableDeclaration(n) &&
              ts.isIdentifier(n.name) &&
              n.name.text === receiver &&
              n.initializer
            ) {
              bindings.push(classify(n.initializer, sf));
            }
            if (
              ts.isBinaryExpression(n) &&
              n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(n.left) &&
              n.left.text === receiver
            ) {
              bindings.push(classify(n.right, sf));
            }
            ts.forEachChild(n, collect);
          };
          collect(scope);
        }
        out.push({
          file: relFile,
          fn: enclosingName(node),
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          op,
          receiver,
          bindings,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

// ---------------------------------------------------------------------------
// Detached `.from(<appointment table>)` detection.
// ---------------------------------------------------------------------------
//
// `supabaseWriteSites()` finds a write by walking BACK from the DML call to a
// `.from(...)` in the SAME expression. A chain split across a variable is
// therefore invisible to it, and the evasion was demonstrated against an
// earlier draft of this guard — the census stayed green:
//
//     const q = admin.from("appointments");
//     await q.update({ status: "completed", starts_at: … });
//
// The blind spot is in the shared helper, which three other guards depend on;
// widening it is not this PR's scope. Instead this closes the hole for the two
// appointment tables specifically, with a rule that needs no data-flow
// analysis: a `.from(<appointment table>)` call must be continued immediately
// with `.something` in the same expression. A `.from()` whose result is bound
// to a variable, returned, or passed as an argument is DETACHED, and its
// eventual operation cannot be censused — so it fails.

function parseAbs(absFile: string): ts.SourceFile {
  return ts.createSourceFile(
    absFile,
    readFileSync(absFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    absFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

type FromCall = { file: string; line: number; fn: string; table: string; detached: boolean };

function appointmentFromCalls(): FromCall[] {
  const out: FromCall[] = [];
  for (const abs of runtimeSourceFiles()) {
    const sf = parseAbs(abs);
    const rel = abs.slice(REPO_ROOT.length + 1).split("\\").join("/");
    const visit = (n: ts.Node) => {
      if (
        ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === "from" &&
        n.arguments.length === 1
      ) {
        const arg = n.arguments[0];
        if (
          (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) &&
          (TABLES as readonly string[]).includes(arg.text)
        ) {
          // Attached iff the very next thing done to the result is a property
          // access on it — i.e. the chain continues in this expression.
          const p = n.parent;
          const attached =
            p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === n;
          out.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            fn: enclosingName(n),
            table: arg.text,
            detached: !attached,
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Census, computed once.
// ---------------------------------------------------------------------------

const ALL_SITES = supabaseWriteSites();
const APPT_SITES = ALL_SITES.filter((s) => s.tableResolved && s.table === APPOINTMENTS);
const AUDIT_SITES = ALL_SITES.filter(
  (s) => s.tableResolved && s.table === APPOINTMENT_AUDIT,
);
const UNRESOLVED_TABLE_SITES = ALL_SITES.filter((s) => !s.tableResolved);
const FROM_CALLS = appointmentFromCalls();

const descriptorOf = (s: WriteSite): Descriptor => ({
  file: s.file,
  fn: s.fn,
  op: s.op,
  table: s.table as ApptTable,
  columns: [...s.columns].sort(),
});
const normalize = (d: Descriptor) => ({ ...d, columns: [...d.columns].sort() });
const sortKey = (d: Descriptor) =>
  `${d.file}|${d.fn}|${d.op}|${d.table}|${[...d.columns].sort().join(",")}`;
const asMultiset = (ds: Descriptor[]) =>
  ds.map(normalize).sort((a, b) => sortKey(a).localeCompare(sortKey(b)));

// ===========================================================================

describe("appointment direct-DML census — T2.5 the analyzer is not vacuous", () => {
  // The failure mode this repository has shipped before is SILENCE: an analyzer
  // that finds nothing, reports a clean tree, and is believed. Every assertion
  // below is worthless unless the census is demonstrably alive, so these run
  // first and are stated as positive controls.

  it("the census walks a real tree and finds a substantial number of write sites", () => {
    expect(
      ALL_SITES.length,
      "supabaseWriteSites() returned an implausibly small census. A near-empty " +
        "result means the analyzer is broken (a moved root, a parse failure, an " +
        "extension filter), NOT that the repository stopped writing to Supabase.",
    ).toBeGreaterThan(100);
  });

  it("it finds ZERO direct appointment writers — and that zero is REAL", () => {
    // The census used to assert SEVEN, and "zero would mean the analyzer is
    // broken" was the honest warning attached to it. B8 makes zero the correct
    // answer, which removes that safety net: a broken analyzer and a clean tree
    // now look identical.
    //
    // So zero is only asserted alongside two live positive controls: the walk
    // still finds >100 Supabase write sites overall (above), and the analyzer
    // still resolves writes to OTHER tables. If both of those hold and
    // `appointments` yields nothing, the tree really is clean.
    expect(
      APPT_SITES,
      "expected ZERO direct `appointments` write sites after B8 / 0177.\nFound:\n" +
        describeSites(APPT_SITES) +
        "\n\nEvery appointment mutation must go through a governed SECURITY DEFINER " +
        "command. If this is a deliberate re-opening of the boundary, add a reviewed " +
        "ALLOWED entry with a justification.",
    ).toHaveLength(0);

    // POSITIVE CONTROL: the analyzer is demonstrably still able to resolve a
    // table-qualified write. A census that resolved nothing would report a
    // clean `appointments` tree for the wrong reason.
    const resolvedElsewhere = ALL_SITES.filter((s) => s.tableResolved && s.table !== APPOINTMENTS);
    expect(
      resolvedElsewhere.length,
      "the analyzer resolved no writes to ANY table, so its zero for " +
        "`appointments` proves nothing.",
    ).toBeGreaterThan(20);
  });

  it("T30/T31/T32 — both former writer files now contain ZERO direct writers", () => {
    // T30 + T31: sendPostcareEmailAction held four (first-send claim, resend
    // claim, failure settle, success settle). T32: autoSendPostcareOnComplete
    // held three (claim, failure settle, success settle). All seven are gone.
    //
    // The files are still scanned — they remain in the analyzer's runtime tree
    // — so a reintroduced writer in either one is caught here, not merely
    // absent from a list.
    expect(
      APPT_SITES.filter((s) => s.file === MANUAL),
      "sendPostcareEmailAction must write appointments only through the commands",
    ).toHaveLength(0);
    expect(
      APPT_SITES.filter((s) => s.file === AUTO),
      "autoSendPostcareOnComplete must write appointments only through the commands",
    ).toHaveLength(0);
    // ANTI-VACUITY, IN THREE LAYERS. An earlier version of this control asked
    // `scanned.has(MANUAL) || scanned.has(AUTO)` over the WRITE-site set, which
    // was wrong twice: `||` proves at-least-one rather than both, and the write
    // set is exactly what B8 emptied for these two files — so a file that
    // correctly contains zero writes is absent from it, and the control could
    // pass while neither file was being read at all.
    //
    // Layer 1: the runtime enumeration still yields both files.
    const runtimeFiles = new Set(
      runtimeSourceFiles().map((abs) => abs.slice(REPO_ROOT.length + 1).split("\\").join("/")),
    );
    expect(runtimeFiles.has(MANUAL), `${MANUAL} must still be enumerated`).toBe(true);
    expect(runtimeFiles.has(AUTO), `${AUTO} must still be enumerated`).toBe(true);

    // Layer 2: the appointment-specific PARSER still observes real
    // `.from("appointments")` calls in each file — they both still READ the
    // table. So the parser is demonstrably reaching and understanding this
    // source, not silently failing on it.
    for (const f of [MANUAL, AUTO]) {
      expect(
        FROM_CALLS.filter((c) => c.file === f && c.table === APPOINTMENTS).length,
        `the parser must still see appointment .from() calls in ${f}`,
      ).toBeGreaterThan(0);
    }

    // Layer 3 is the assertion above: zero MUTATIONS. Together these three mean
    // the tree is clean, not that the analyzer went blind.
  });

  it("it resolves every appointment writer's table AND payload (nothing silently skipped)", () => {
    const opaque = APPT_SITES.filter((s) => s.unresolved !== null);
    expect(
      opaque,
      "an appointment writer became unreadable to the analyzer. An unresolvable " +
        "payload cannot be column-checked, so it must be treated as a failure:\n" +
        describeSites(opaque),
    ).toEqual([]);
  });
});

describe("T2.1 — the appointment writer census is frozen", () => {
  it("no direct `appointments` writer exists outside the reviewed set (now empty)", () => {
    const allowedKeys = new Set(ALLOWED.map((d) => sortKey(d)));
    const undeclared = APPT_SITES.filter((s) => !allowedKeys.has(sortKey(descriptorOf(s))));
    expect(
      undeclared,
      "a NEW direct `appointments` writer appeared, or an existing one changed its " +
        "function, operation or payload columns.\n\n" +
        "Direct table DML on `appointments` bypasses every reviewed SECURITY DEFINER " +
        "command — no availability validation, no owner gate, no legal-transition " +
        "check and no `appointment_audit` row (no trigger writes it). Route the write " +
        "through a command, or add a reviewed entry to ALLOWED with a justification.\n\n" +
        describeSites(undeclared),
    ).toEqual([]);
  });

  it("the census matches the reviewed set exactly, as a multiset", () => {
    // A set comparison would let a duplicate appear or a duplicate vanish
    // unnoticed: two sites in sendPostcareEmailAction are descriptor-identical.
    expect(asMultiset(APPT_SITES.map(descriptorOf))).toEqual(
      asMultiset(ALLOWED.map((a) => ({
        file: a.file,
        fn: a.fn,
        op: a.op,
        table: a.table,
        columns: a.columns,
      }))),
    );
  });

  it("every reviewed writer carries a written justification", () => {
    for (const a of ALLOWED) {
      expect(a.why.trim().length, `${a.file} ${a.fn} needs a real justification`)
        .toBeGreaterThan(40);
    }
  });

  it("every appointment writer is an UPDATE — the app creates and deletes nothing directly", () => {
    // Creation goes through create_internal_appointment_v2 / create_public_appointment;
    // there is no appointment DELETE anywhere in the product (audit §4, workflow 12).
    // After B8 there is no direct appointment DML of ANY kind — not UPDATE,
    // and (as always) not INSERT or DELETE. Stated as the empty set so a
    // reintroduced writer of any operation fails here.
    expect(APPT_SITES.map((s) => s.op).sort()).toEqual([]);
  });
});

describe("T2.2 — direct writers may touch postcare bookkeeping columns and nothing else", () => {
  // THE LOAD-BEARING ASSERTION. T2.1 freezes WHICH files write; this freezes
  // WHAT they write. A payload that grows `status` or `starts_at` inside an
  // already-allowed function would pass a file-level allowlist and fail here.

  it("every written column is a postcare_email_* bookkeeping field", () => {
    const offenders = APPT_SITES.flatMap((s) =>
      s.columns
        .filter((c) => !POSTCARE_BOOKKEEPING_COLUMNS.has(c))
        .map((c) => `${s.file}:${s.line} ${s.fn}() writes \`${c}\``),
    );
    expect(
      offenders,
      "a direct `appointments` writer began writing a column outside the postcare " +
        "bookkeeping family. Scheduling, tenancy, lifecycle and money columns are " +
        "owned by the reviewed commands and must never be written directly.",
    ).toEqual([]);
  });

  it("no direct writer touches any scheduling, lifecycle, tenancy or lineage column", () => {
    const forbidden = new Set<string>(FORBIDDEN_COLUMNS);
    const offenders = APPT_SITES.flatMap((s) =>
      s.columns.filter((c) => forbidden.has(c)).map((c) => `${s.file}:${s.line} → ${c}`),
    );
    expect(offenders).toEqual([]);
  });

  it("the reviewed column set is exactly the six that exist in the schema", () => {
    // Pinned so that adding a seventh postcare column is a deliberate edit here
    // rather than something a payload silently inherits.
    expect([...POSTCARE_BOOKKEEPING_COLUMNS].sort()).toEqual([
      "postcare_email_claimed_at",
      "postcare_email_failed_at",
      "postcare_email_last_attempt_at",
      "postcare_email_last_error",
      "postcare_email_send_attempts",
      "postcare_email_sent_at",
    ]);
    // The six columns still EXIST — they are the postcare bookkeeping family —
    // but after B8 no runtime writer touches them directly. Only
    // settle_postcare_send / claim_postcare_send write them, inside SQL.
    const used = new Set(APPT_SITES.flatMap((s) => s.columns));
    expect([...used].sort(), "no direct writer may touch postcare columns").toEqual([]);
  });
});

describe("T2.3 — `appointment_audit` has no direct runtime writer", () => {
  // Reading it is fine and shipped: app/(app)/calendar/[id]/page.tsx renders the
  // cancellation insight. Writing it is not. The 0010 member INSERT policy plus
  // the never-revoked grant make the table forgeable today (audit P1-3); the
  // application must not depend on that being true.

  it("no runtime module inserts, updates, upserts or deletes appointment_audit", () => {
    expect(
      AUDIT_SITES,
      "the application must never write `appointment_audit` directly. Every audit " +
        "row is written by the SECURITY DEFINER command that performed the mutation, " +
        "in the SAME transaction. A direct write is an un-attributed audit row.\n" +
        describeSites(AUDIT_SITES),
    ).toEqual([]);
  });
});

describe("T2.4 — unresolved table targets fail closed", () => {
  // `.from(variable)` hides from every literal census. The analyzer reports such
  // sites as unresolved rather than skipping them; this asserts each one is
  // provably incapable of naming an appointment table.

  it("exactly one variable-table writer exists, and it is the reviewed one", () => {
    expect(
      UNRESOLVED_TABLE_SITES.map((s) => `${s.file} ${s.fn}()`),
      "a NEW `.from(variable)` writer appeared. A variable table name can resolve to " +
        "`appointments` at runtime while passing every literal census, so it must be " +
        "reviewed here before it ships.",
    ).toEqual(["app/(app)/clients/[id]/sessions/[sessionId]/actions.ts softDeleteEntry()"]);
  });

  it("its table parameter is a closed literal union that excludes both appointment tables", () => {
    // Proved from the annotation, not from a comment: `table:
    // "electrolysis_entries" | "laser_entries"`. A widened union fails here.
    const rel = "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts";
    const sf = parse(rel);
    let members: string[] | null = null;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "softDeleteEntry") {
        const p = n.parameters.find(
          (x) => ts.isIdentifier(x.name) && x.name.text === "table",
        );
        if (p?.type && ts.isUnionTypeNode(p.type)) {
          const lits = p.type.types.map((t) =>
            ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : null,
          );
          if (lits.every((l): l is string => l !== null)) members = lits.sort();
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(
      members,
      "softDeleteEntry's `table` parameter must remain a closed union of string literals",
    ).toEqual(["electrolysis_entries", "laser_entries"]);
    for (const t of TABLES) {
      expect(members as unknown as string[]).not.toContain(t);
    }
  });

  it("no unresolved-table site has an unreadable payload that could hide an appointment write", () => {
    // Mirrors writesToColumn()'s doctrine: a site whose table is unknown but
    // whose payload IS fully resolved cannot write a column it never names.
    // A site that is unknown on BOTH axes is unprovable and must fail.
    const doublyOpaque = UNRESOLVED_TABLE_SITES.filter(
      (s) => s.unresolved !== null && /payload/.test(s.unresolved),
    );
    expect(
      doublyOpaque,
      "a write site has BOTH an unresolved table and an unresolved payload. Nothing " +
        "can prove it is not an appointment write:\n" + describeSites(doublyOpaque),
    ).toEqual([]);
  });

  it("no `.from(appointments | appointment_audit)` call is detached from its chain", () => {
    // Closes the analyzer blind spot demonstrated in this PR's negative
    // controls: `const q = admin.from("appointments"); await q.update({...})`
    // is a real, dangerous write that supabaseWriteSites() does not report.
    const detached = FROM_CALLS.filter((f) => f.detached);
    expect(
      detached.map((f) => `${f.file}:${f.line} in ${f.fn}() — .from("${f.table}")`),
      "a `.from()` on an appointment table is not immediately continued in the same " +
        "expression. Splitting the chain across a variable hides the eventual operation " +
        "from the census entirely, so the write cannot be reviewed. Keep the chain " +
        "in one expression.",
    ).toEqual([]);
  });

  it("the detached-chain detector is itself non-vacuous", () => {
    // It must be finding the real `.from("appointments")` calls — reads
    // included — or its empty `detached` list means nothing.
    expect(
      FROM_CALLS.length,
      "the `.from(appointments)` scan found nothing; the detector is broken",
    ).toBeGreaterThanOrEqual(7);
    expect(FROM_CALLS.every((f) => (TABLES as readonly string[]).includes(f.table))).toBe(true);
  });

  it("no unresolved-table site names a column of either appointment table", () => {
    const apptColumns = new Set<string>([
      ...POSTCARE_BOOKKEEPING_COLUMNS,
      ...FORBIDDEN_COLUMNS,
      // appointment_audit (0010:217-225)
      "appointment_id",
      "actor_type",
      "actor_id",
      "action",
      "details",
    ]);
    const offenders = UNRESOLVED_TABLE_SITES.flatMap((s) =>
      s.columns.filter((c) => apptColumns.has(c)).map((c) => `${s.file}:${s.line} → ${c}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("T2.6 — every direct appointment writer runs as service_role", () => {
  // Deliberately the INVERSE of the clinical guard in
  // entry-direct-dml-guard.test.ts. There, an admin receiver is the failure.
  // Here it is the requirement: these seven writes must not be the reason the
  // `authenticated` grant has to be retained.

  const files = [MANUAL, AUTO];

  it("both writer files import a service-role client module", () => {
    for (const f of files) {
      const imports = adminModuleImports(f);
      expect(
        imports.length,
        `${f} performs direct appointment DML but imports no admin/service-role module`,
      ).toBeGreaterThan(0);
    }
  });

  it("there is no appointment write chain left whose receiver could be resolved", () => {
    // This block used to prove all SEVEN receivers were createAdminClient().
    // With zero writers the property inverts: there is no chain at all, so
    // there is no receiver to be wrong about.
    const proofs = files.flatMap((f) => receiverProofs(f, TABLES));
    expect(proofs, "no direct appointment write chain may remain").toHaveLength(0);

    for (const p of proofs) {
      expect(p.receiver, `${p.file}:${p.line} — receiver is not a plain identifier`).not
        .toBeNull();
      const kinds = p.bindings.map((b) => b.kind);
      expect(
        kinds,
        `${p.file}:${p.line} in ${p.fn}() — could not resolve any binding for receiver ` +
          `\`${p.receiver}\`. An unresolvable receiver is an unproven privilege level.`,
      ).not.toEqual([]);
      expect(
        kinds.filter((k) => k === "admin-factory").length,
        `${p.file}:${p.line} in ${p.fn}() — receiver \`${p.receiver}\` is never assigned ` +
          `from createAdminClient(). Bindings: ${JSON.stringify(p.bindings)}`,
      ).toBeGreaterThan(0);
      expect(
        p.bindings.filter((b) => b.kind === "unknown"),
        `${p.file}:${p.line} in ${p.fn}() — receiver \`${p.receiver}\` has a binding the ` +
          `analyzer cannot classify. Fail closed.`,
      ).toEqual([]);
    }
  });

  it("the one injected-dependency seam is the test hook, alongside a real admin factory", () => {
    // postcare-auto-send.ts takes `deps?.admin` so unit tests can inject a fake,
    // then falls back to createAdminClient(). Both bindings must be present:
    // the seam alone would prove nothing about production.
    const auto = receiverProofs(AUTO, TABLES);
    for (const p of auto) {
      const kinds = new Set(p.bindings.map((b) => b.kind));
      expect(kinds.has("admin-factory")).toBe(true);
      expect(kinds.has("authenticated-factory")).toBe(false);
    }
    const manual = receiverProofs(MANUAL, TABLES);
    for (const p of manual) {
      expect(p.bindings.map((b) => b.kind)).toEqual(["admin-factory"]);
    }
  });
});

describe("T2.7 — no authenticated-client writer for either appointment table", () => {
  // This is the assertion the future migration 0172 depends on. If it ever goes
  // red, `revoke insert, update, delete on public.appointments from
  // authenticated` stops being a zero-application-change migration.
  //
  // It must be evaluated across the WHOLE runtime tree, not just the two known
  // files, or a new authenticated writer in a third file would go unnoticed.

  it("no runtime module writes either appointment table through the cookie client", () => {
    const filesWithApptWrites = [...new Set([...APPT_SITES, ...AUDIT_SITES].map((s) => s.file))];
    // Belt: the census already proves the file set is exactly the two known ones.
    expect(filesWithApptWrites, "T33: no runtime file writes appointments directly").toEqual([]);

    // FAIL CLOSED. Stating this as "no receiver is an authenticated factory"
    // alone passes VACUOUSLY when the receiver cannot be resolved at all — a
    // receiver with zero bindings has no authenticated binding either. That was
    // observed: switching one writer to `supabase` (a name never declared in
    // that function's scope) left this assertion green while only T2.6 caught
    // it. So the property asserted here is the POSITIVE one — every receiver is
    // provably service-role — and anything unproven is an offender.
    const offenders = filesWithApptWrites.flatMap((f) =>
      receiverProofs(f, TABLES)
        .filter((p) => {
          const kinds = p.bindings.map((b) => b.kind);
          const provenAdmin =
            kinds.length > 0 &&
            kinds.includes("admin-factory") &&
            !kinds.includes("authenticated-factory") &&
            !kinds.includes("unknown");
          return !provenAdmin;
        })
        .map(
          (p) =>
            `${p.file}:${p.line} in ${p.fn}() — receiver \`${p.receiver}\`, bindings ` +
            `${JSON.stringify(p.bindings.map((b) => b.kind))}`,
        ),
    );
    expect(
      offenders,
      "an appointment write is NOT provably issued through the service-role client. " +
        "This is the single premise migration 0172 rests on: because no shipped writer " +
        "needs the `authenticated` INSERT/UPDATE/DELETE grant on `appointments`, " +
        "revoking it is a zero-application-change migration. An authenticated receiver " +
        "breaks that premise outright; an UNRESOLVABLE receiver leaves it unproven, " +
        "which is treated the same way. Fix the writer, not this test.",
    ).toEqual([]);
  });

  it("`app/(app)/calendar/actions.ts` uses BOTH factories — and only the admin one writes", () => {
    // This file legitimately holds an authenticated client for reads
    // (createClient at :197, :471, …). The point of a per-RECEIVER proof rather
    // than a per-MODULE one is that this file must still pass.
    const src = readFileSync(join(REPO_ROOT, MANUAL), "utf8");
    expect(src).toContain("createClient");
    expect(src).toContain("createAdminClient");
    for (const p of receiverProofs(MANUAL, TABLES)) {
      expect(p.bindings.map((b) => b.kind)).toEqual(["admin-factory"]);
    }
  });

  it("the two writer files still exist where the guard expects them", () => {
    // A rename would otherwise empty every file-scoped assertion above and pass.
    for (const f of [MANUAL, AUTO]) {
      expect(() => statSync(join(REPO_ROOT, f)), `${f} moved or was deleted`).not.toThrow();
    }
  });
});

describe("appointment direct-DML census — the report", () => {
  it("prints the frozen census for the reviewer", () => {
    // eslint-disable-next-line no-console
    console.log(
      "\nAppointment direct-DML census (frozen at PR B1) —\n" +
        describeSites(APPT_SITES) +
        `\n\n  appointment_audit direct writers: ${AUDIT_SITES.length}` +
        `\n  variable-table writers in tree:   ${UNRESOLVED_TABLE_SITES.length}` +
        `\n  total Supabase write sites:       ${ALL_SITES.length}\n`,
    );
    expect(APPT_SITES).toHaveLength(0);
  });
});
