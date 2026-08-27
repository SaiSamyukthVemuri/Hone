import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import { UNKNOWN_EXPLANATION, UNKNOWN_LABEL, PERMANENT_LINES } from "@/lib/finance/financial-copy";
import { summarizeCalendar } from "@/lib/finance/financial-briefing-model";
import type { FinancialUnknownCause } from "@/lib/finance/financial-fact";

// ===========================================================================
// FIN-01A SLICE 1 — the source guard
// ===========================================================================
//
// Load-bearing negative controls. Each one names the wrong behaviour it
// forbids, so a future author cannot satisfy it by deleting the assertion.
//
// Comments are stripped before matching: several of these files DISCUSS the
// tables and the coercions they must never perform, and the discussion is the
// documentation. Only executable source is searched.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FILES = {
  fact: "lib/finance/financial-fact.ts",
  copy: "lib/finance/financial-copy.ts",
  model: "lib/finance/financial-briefing-model.ts",
  loader: "lib/finance/financial-briefing.ts",
  page: "app/(app)/financials/page.tsx",
  spine: "app/(app)/financials/financial-spine.tsx",
} as const;

const SOURCE = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, read(rel)]),
) as Record<keyof typeof FILES, string>;
const CODE = Object.fromEntries(
  Object.entries(SOURCE).map(([k, src]) => [k, codeOnly(src)]),
) as Record<keyof typeof FILES, string>;
const ALL_CODE = Object.values(CODE).join("\n");

const ALL_CAUSES: FinancialUnknownCause[] = [
  "not_recorded",
  "unavailable",
  "unknowable",
  "not_yet_supported",
  "not_enumerable",
];

// ---------------------------------------------------------------------------
// 1. No money arithmetic entered Slice 1
// ---------------------------------------------------------------------------

describe("NC1-3 — Slice 1 contains no money, from any of the three truth classes", () => {
  const LEDGERS = [
    // Hone-verified card money.
    "payment_charge_attempts",
    "charged_at",
    "refunded_at",
    "refund_status",
    "stripe_livemode",
    // Practitioner-attested disposition (migration 0187).
    "appointment_settlements",
    "amount_cents",
    "quoted_amount_cents",
    "paid_cash",
    "paid_e_transfer",
    "still_owes",
    // Service value.
    "price_cents",
    "price_paid_cents",
    // The dormant and legacy decoys, which must never be read by anything.
    "manual_fee_charge_attempts",
    "stripe_charge_attempts",
    "appointment_payments",
    "stripe_refunds",
    "stripe_refund_attempts",
  ];

  it.each(LEDGERS)("no executable reference to %s", (identifier) => {
    expect(ALL_CODE).not.toContain(identifier);
  });

  it("reads exactly ONE table, and it is appointments", () => {
    const tables = [...CODE.loader.matchAll(/\.from\((["'])([^"']+)\1\)/g)].map((m) => m[2]);
    expect(tables).toEqual(["appointments"]);
    expect(ALL_CODE.match(/\.from\(/g) ?? []).toHaveLength(1);
  });

  it("selects only the status column — no amount, no price, no join", () => {
    expect(CODE.loader).toContain('.select("status", { count: "exact" })');
  });
});

// ---------------------------------------------------------------------------
// 2. UNKNOWN cannot become zero
// ---------------------------------------------------------------------------

describe("NC4/NC9 — an absence has no coercion route to a number", () => {
  it("there is no valueOr / getOrElse / unwrapOr helper anywhere", () => {
    // A coercion helper is the single mechanism by which "we could not read
    // this" becomes "$0.00", and once it exists somebody reaches for it.
    expect(ALL_CODE).not.toMatch(/\b(valueOr|getOrElse|unwrapOr|orZero|orDefault)\b/);
  });

  it("no fact is defaulted with ?? or || to a number or a currency string", () => {
    expect(ALL_CODE).not.toMatch(/\.value\s*(\?\?|\|\|)/);
    expect(ALL_CODE).not.toMatch(/(\?\?|\|\|)\s*["'`]\$?0/);
    // The I/O and render paths — where a Fact is in scope — carry no numeric
    // default at all. The rule is narrowed to them deliberately: a blanket ban
    // would also forbid the census counter below, which is a legitimate zero.
    for (const key of ["loader", "spine", "page", "fact", "copy"] as const) {
      expect(CODE[key], key).not.toMatch(/(\?\?|\|\|)\s*0\b/);
    }
  });

  it("the model's ONLY zero-default is the census counter, which is a real zero", () => {
    // `byStatus.get(status) ?? 0` means "this status had no rows in a read that
    // succeeded". That is `known(0)`, not a coerced unknown — and it is the one
    // place a literal zero may be written in the slice.
    const defaults = [...CODE.model.matchAll(/[^\n]*(\?\?|\|\|)\s*0\b[^\n]*/g)].map((m) =>
      m[0].trim(),
    );
    expect(defaults).toEqual([
      "byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);",
      "const count = (status: AppointmentStatusName) => known(byStatus.get(status) ?? 0);",
    ]);
  });

  it("no figure is rendered as a bare dash or an em dash placeholder", () => {
    expect(CODE.spine).not.toMatch(/>\s*[-—–]\s*</);
  });

  it("the render path narrows the union rather than reading .value unguarded", () => {
    // Every read of `.value` in the spine sits behind a `.known` check.
    expect(CODE.spine).toMatch(/if \(!fact\.known\) return <Unknown cause=\{fact\.cause\} \/>;/);
    expect(CODE.spine).toMatch(/calendar\.completed\.known \?/);
  });
});

// ---------------------------------------------------------------------------
// 3. The five causes stay five
// ---------------------------------------------------------------------------

describe("NC7/NC8 — the causes are not collapsed at the render boundary", () => {
  it("every cause has its own label, explanation and SHAPE", () => {
    for (const cause of ALL_CAUSES) {
      expect(UNKNOWN_LABEL[cause]).toBeTruthy();
      expect(UNKNOWN_EXPLANATION[cause]).toBeTruthy();
      // Colour is never the only channel: the mark map is exhaustive.
      expect(CODE.spine).toContain(`${cause}:`);
    }
  });

  it("no shared 'Not available' fallback survives anywhere", () => {
    expect(ALL_CODE).not.toMatch(/Not available/i);
  });

  it("the permanent framing lines are all rendered", () => {
    expect(CODE.spine).toContain("PERMANENT_LINES");
    expect(PERMANENT_LINES).toHaveLength(3);
    for (const line of PERMANENT_LINES) expect(line.length).toBeGreaterThan(40);
  });

  it("asserts no apply date for the historical boundary", () => {
    // docs/production/migration-state.json records 0187 with
    // hosted_applied_at: null and states no server apply instant was captured.
    // Printing one to an owner would claim precision the canonical record
    // explicitly declines to claim.
    expect(SOURCE.copy).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(CODE.copy).not.toMatch(/\b(August|September|October)\b/);
  });
});

// ---------------------------------------------------------------------------
// 3b. The screen claims only what the model guarantees
// ---------------------------------------------------------------------------
//
// The partition note printed "Every appointment in this period is on exactly
// one line above" whenever `partition.closed`. Codex raised it on PR #646 and
// was right: `closed` means every appointment fell into one of the four KNOWN
// STATUSES, which is a claim about status coverage, while the sentence asserted
// a claim about ROW LAYOUT — and that one was false twice over. `Booked in this
// period` is the total, so every appointment is on that line AND on its status
// line; and `completed` has no line in that section at all.
//
// Nothing caught it because every test asserted `partition.closed` — the model
// fact — and none asserted what the SENTENCE told the owner. These do.

/**
 * The two sentences `PartitionNote` can render, extracted INDEPENDENTLY of each
 * other from the AST.
 *
 * The first version of this guard searched a 1200-character slice of the source
 * around `PartitionNote`, which spans BOTH return branches. Codex raised it on
 * #646 and was right: a status word deleted from one sentence still appeared in
 * the other, so the assertion could not fail. Verified before repairing —
 * removing `completed` from the coverage sentence, `cancelled` from it, or
 * `no-show` from the withdrawal sentence each left the suite green.
 *
 * Worse, my own negative control had hidden it. The control that was meant to
 * prove the four-status assertion removed a status AND the next-section pointer
 * in one edit, so it went red for the pointer and read as though the status
 * assertion had fired. A control that changes two facts proves neither.
 *
 * So the branches are now separated structurally rather than by proximity: the
 * coverage message is the return inside `if (partition.closed)`, the withdrawal
 * message is the function's final return, and each is asserted on its own text.
 * One branch cannot borrow a word from the other.
 */
function partitionMessages(): { coverage: string; withdrawal: string } {
  const sf = ts.createSourceFile(
    FILES.spine,
    SOURCE.spine,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  let fn: ts.FunctionDeclaration | undefined;
  const findFn = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "PartitionNote") fn = node;
    ts.forEachChild(node, findFn);
  };
  findFn(sf);
  if (!fn?.body) throw new Error("PartitionNote not found — this guard cannot run");

  /** The prose a viewer reads: JSX text only, whitespace collapsed. */
  const visibleText = (node: ts.Node): string => {
    const parts: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isJsxText(n)) parts.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };

  let coverage: string | undefined;
  let withdrawal: string | undefined;
  for (const statement of fn.body.statements) {
    if (
      ts.isIfStatement(statement) &&
      statement.expression.getText(sf).includes("partition.closed")
    ) {
      coverage = visibleText(statement.thenStatement);
    } else if (ts.isReturnStatement(statement) && statement.expression) {
      withdrawal = visibleText(statement);
    }
  }
  if (!coverage) throw new Error("no `if (partition.closed)` branch — the gate is gone");
  if (!withdrawal) throw new Error("no withdrawal branch — the retraction is gone");
  return { coverage, withdrawal };
}

/**
 * The CLAIM sentence within a message: the one that says what accounts for what.
 *
 * Asserting the statuses against the whole coverage message was still too
 * loose, and a one-fact-at-a-time control caught it: deleting `completed` from
 * the enumeration left the message false — "Still to happen, cancelled and
 * no-show account for every appointment booked" — while the word survived in
 * the pointer sentence, "Completed is counted in the next section", so the
 * assertion stayed green. The enumeration is the thing making the claim, so the
 * enumeration is what gets asserted.
 */
function claimSentence(message: string): string {
  const sentence = message
    .split(/(?<=\.)\s+/)
    .find((part) => /account for every appointment/i.test(part));
  if (!sentence) throw new Error(`no claim sentence in: ${message}`);
  return sentence;
}

/**
 * The four statuses AS THE OWNER SEES THEM.
 *
 * `confirmed` is deliberately absent. The screen never uses that word: the row
 * is labelled "Still to happen", and `stillToHappen: count("confirmed")` is
 * where the model does the translation. Asserting "confirmed" would force copy
 * to satisfy a test rather than describe the product, so the vocabulary here is
 * the rendered one and matches the row labels above it.
 */
const PARTITION_STATUS_WORDS = ["still to happen", "completed", "cancelled", "no-show"];

describe("NC-claim — the partition note states status coverage, not row layout", () => {
  const messages = partitionMessages();
  const normalise = (text: string) => text.toLowerCase();

  it("EXTRACTION IS REAL: the two messages are distinct, non-trivial prose", () => {
    // If extraction silently returned "" for either branch, every assertion
    // below would pass vacuously — which is the shape of the bug being fixed.
    expect(messages.coverage.length).toBeGreaterThan(40);
    expect(messages.withdrawal.length).toBeGreaterThan(40);
    expect(messages.coverage).not.toEqual(messages.withdrawal);
    // ...and neither contains the other, so "independent" is literal.
    expect(messages.coverage.includes(messages.withdrawal)).toBe(false);
    expect(messages.withdrawal.includes(messages.coverage)).toBe(false);
  });

  it.each(PARTITION_STATUS_WORDS)("the COVERAGE claim enumerates %s", (word) => {
    // The CLAIM sentence, not the whole message: the pointer sentence also says
    // "Completed", and letting that satisfy this would re-open the hole.
    const claim = claimSentence(messages.coverage);
    expect(normalise(claim), claim).toContain(word);
  });

  it.each(PARTITION_STATUS_WORDS)("the WITHDRAWAL claim enumerates %s", (word) => {
    // Asserted against the withdrawal text ALONE. Before this repair the same
    // word in the coverage sentence would have satisfied it.
    const claim = claimSentence(messages.withdrawal);
    expect(normalise(claim), claim).toContain(word);
  });

  it("makes no claim that a line-by-line reading is exact", () => {
    // The exact false sentence, and the family it belongs to. A layout claim is
    // unprovable from a status census however it is phrased.
    expect(CODE.spine).not.toMatch(/exactly one line/i);
    expect(CODE.spine).not.toMatch(/on (exactly )?one (line|row)/i);
    expect(CODE.spine).not.toMatch(/each appointment appears once/i);
  });

  it("the COVERAGE message says where the fourth count is shown", () => {
    // `completed` is rendered in "Work actually completed". A claim covering it
    // that did not say so would send the owner looking for a row that is not
    // there. Deliberately a SEPARATE test from the status words, so removing
    // the pointer can never read as proof that a status assertion fired.
    expect(normalise(messages.coverage)).toMatch(/next section/);
  });

  it("the calendar section really does NOT carry a completed row", () => {
    const calendarSection = CODE.spine.indexOf("The calendar");
    const completedSection = CODE.spine.indexOf("Work actually completed");
    expect(calendarSection).toBeGreaterThan(-1);
    expect(completedSection).toBeGreaterThan(calendarSection);
    const calendarRows = CODE.spine.slice(calendarSection, completedSection);
    expect(calendarRows).toContain('label="Booked in this period"');
    expect(calendarRows).not.toContain('label="Completed"');
  });

  it("the claim is printed ONLY when the model says it holds", () => {
    expect(CODE.spine).toContain("if (partition.closed)");
    expect(CODE.spine).toContain("if (!booked.known) return null;");
  });

  it("THE FACT ITSELF: the four statuses really do sum to booked when closed", () => {
    // The arithmetic the sentence asserts, proved against the model rather than
    // assumed from its name. No `if (known)` guard: an unknown fact must FAIL
    // this, not silently skip it.
    for (const statuses of [
      ["confirmed", "completed", "cancelled", "no_show"],
      ["completed", "completed", "completed"],
      [],
      ["cancelled", "no_show", "no_show", "confirmed", "completed", "completed"],
    ]) {
      const census = summarizeCalendar(statuses.map((status) => ({ status })));
      expect(census.partition.closed, statuses.join(",")).toBe(true);
      const parts = [
        census.stillToHappen,
        census.completed,
        census.cancelled,
        census.noShow,
      ];
      expect(parts.every((f) => f.known)).toBe(true);
      expect(census.booked.known).toBe(true);
      const sum = parts.reduce((total, f) => total + (f.known ? f.value : NaN), 0);
      expect(sum, statuses.join(",")).toBe(census.booked.known ? census.booked.value : NaN);
    }
  });

  it("and the withdrawal is what the model asks for when it does NOT hold", () => {
    const census = summarizeCalendar([{ status: "rescheduled" }, { status: "completed" }]);
    expect(census.partition.closed).toBe(false);
    expect(census.partition.unrecognisedStatuses).toEqual(["rescheduled"]);
    expect(normalise(messages.withdrawal)).toMatch(/do not account for every appointment booked/);
  });
});


// ---------------------------------------------------------------------------
// 4. Authority
// ---------------------------------------------------------------------------

describe("NC-auth — the gate precedes the read, and claims no more than it is", () => {
  it("the role refusal is the FIRST statement of the loader", () => {
    // Not merely present: first. A read issued before the check is an aggregate
    // payload a practitioner caused, whatever the page then renders.
    expect(CODE.loader).toMatch(
      /Promise<FinancialsView>\s*\{\s*if \(practitioner\.role !== "owner"\) return \{ access: "refused" \};/,
    );
  });

  it("the page refuses before it renders the spine", () => {
    const refusal = CODE.page.indexOf('view.access === "refused"');
    const spine = CODE.page.indexOf("<FinancialSpine");
    expect(refusal).toBeGreaterThan(-1);
    expect(spine).toBeGreaterThan(refusal);
  });

  it("does not describe itself as a database boundary", () => {
    const claims = /owner-only (data|database|row) boundary|RLS[^.]{0,40}owner/i;
    expect(SOURCE.loader).not.toMatch(claims);
    expect(SOURCE.page).not.toMatch(claims);
  });

  it("states in source that the gate is application-layer only", () => {
    // Prose wraps across comment lines, so strip the markers before matching.
    const prose = SOURCE.loader.replace(/^\s*(\/\/|\*)/gm, " ").replace(/\s+/g, " ");
    expect(prose).toMatch(/is_studio_member/);
    expect(prose).toMatch(/NOT a database boundary/i);
    expect(prose).toMatch(/decides who is SHOWN the aggregate/i);
  });

  it("financial truth is never cached", () => {
    expect(CODE.page).toContain('export const dynamic = "force-dynamic"');
  });
});

// ---------------------------------------------------------------------------
// 5. Read-only
// ---------------------------------------------------------------------------

describe("NC-readonly — no mutation, no RPC, no schema", () => {
  it.each([".insert(", ".update(", ".delete(", ".upsert(", ".rpc("])(
    "no %s anywhere in the slice",
    (verb) => {
      expect(ALL_CODE).not.toContain(verb);
    },
  );

  it("no migration, trigger or policy text is introduced by the slice", () => {
    expect(ALL_CODE).not.toMatch(/create (table|policy|index|function)/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Responsive and accessible
// ---------------------------------------------------------------------------

describe("NC-mobile/a11y — order carries the meaning, colour never does", () => {
  it("the provenance chain cannot be re-sequenced by a viewport", () => {
    // No grid, no CSS ordering, no reversal: stacking a single column cannot
    // change the reading order of calendar -> anchor -> what became of it.
    expect(CODE.spine).not.toMatch(/\border-\d/);
    expect(CODE.spine).not.toMatch(/\b(flex-row-reverse|flex-col-reverse)\b/);
    expect(CODE.spine).not.toMatch(/\bgrid-cols-/);
  });

  it("renders the sections in the frozen Direction B order", () => {
    const order = [
      "The calendar",
      "Work actually completed",
      "Where the completed work went",
      "Money in this period",
    ].map((heading) => CODE.spine.indexOf(heading));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("nothing is pinned to a fixed pixel width that could overflow a phone", () => {
    expect(CODE.spine).not.toMatch(/(?<![\w-])w-\[\d+px\]/);
    expect(CODE.spine).toContain("max-w-[920px]");
    // Flex children that hold prose declare min-w-0, or a long word forces the
    // row wider than the viewport instead of wrapping.
    expect(CODE.spine).toContain("min-w-0");
  });

  it("headings are real headings, not styled captions", () => {
    const h2s = CODE.spine.match(/<SectionLabel as="h2">/g) ?? [];
    expect(h2s.length).toBeGreaterThanOrEqual(4);
    expect((CODE.spine.match(/<h1/g) ?? []).length).toBe(1);
  });

  it("load-bearing financial explanation never rides on muted-over-sunken", () => {
    // Measured 4.54:1 — it clears AA by 0.04. Captions may use it; sentences
    // that carry the meaning of a missing figure may not.
    for (const [name, code] of Object.entries(CODE)) {
      for (const line of code.split("\n")) {
        const bad = line.includes("text-fg-muted") && line.includes("bg-surface-sunken");
        expect(bad, `${name}: ${line.trim()}`).toBe(false);
      }
    }
  });

  it("every decorative mark is hidden from assistive technology and paired with text", () => {
    expect(CODE.spine).toContain('aria-hidden="true"');
    expect(CODE.spine).toContain("UNKNOWN_LABEL[cause]");
  });

  it("the active period is announced, not only painted", () => {
    expect(CODE.spine).toMatch(/aria-current=\{active \? "page" : undefined\}/);
  });
});

// ---------------------------------------------------------------------------
// 7. Slice boundary
// ---------------------------------------------------------------------------

describe("NC-scope — the later slices are absent, and say so", () => {
  it("names both unbuilt sections in a sentence rather than a zero", () => {
    expect(CODE.spine).toContain("DISPOSITION_CHAIN_NOT_YET");
    expect(CODE.spine).toContain("MONEY_BRIDGES_NOT_YET");
    expect(CODE.spine).toContain('<Unknown cause="not_yet_supported" />');
  });

  it("does not register or advertise the route", () => {
    // The nav landing is its own slice. This PR must not add a NAV_ENTRIES row.
    const registry = read("lib/search/navigation-registry.ts");
    expect(registry).toContain('route: "/financials"');
    const navEntries = registry.slice(0, registry.indexOf("NON_SEARCHABLE_ROUTES"));
    expect(navEntries).not.toContain("/financials");
  });
});

// ---------------------------------------------------------------------------
// 8. What this file proves — and what it does not
// ---------------------------------------------------------------------------
//
// An earlier architecture here tried to prove a NEGATIVE: that no JavaScript
// expression anywhere in FIN's dependencies could load the money module. It did
// that by recognising the spellings a loader can take, and eleven review rounds
// each found one more — side-effect import, `require`, `(require)`, an
// instantiation expression, a conditional, a computed member key, a non-literal
// dynamic import, an explicit `.js` specifier, `createRequire`, a
// namespace-qualified `createRequire`, and finally `process.getBuiltinModule`,
// which needs no import at all. The file grew from 547 lines to 1764 while what
// it protected stayed one boolean.
//
// TRUTH-01A reached the same place in production and withdrew its own
// application-source reachability analyser for the same reason: "Enumerating
// the syntax of a language to prove a negative is the wrong shape of evidence
// for this slice" (#644, commit 47253256). This block is the FIN equivalent of
// that withdrawal, and the claim below is deliberately smaller than the one it
// replaces.
//
// PROVEN HERE
//
//   The TypeScript compiler, using this repository's own tsconfig, resolves
//   FIN's static ESM dependency graph — bundler semantics, `@/*` aliases,
//   extension substitution and package resolution all inherited rather than
//   imitated. Every module in the resulting closure is scanned, and none
//   contains a forbidden money identifier. A dependency site the compiler
//   cannot resolve is a VIOLATION rather than an absence, so the closure cannot
//   shrink silently — which is the failure mode that produced four of the
//   eleven rounds.
//
// ENFORCED AS A CODING CONSTRAINT, NOT PROVEN HERE
//
//   In FIN-OWNED source — app/(app)/financials/** and lib/finance/** — three
//   stable ESLint rules reject loader forms including:
//
//     * a value-position `require`, `module` or `exports`, in any expression
//       shape (called, aliased, parenthesised, instantiated, conditional,
//       comma-sequenced, or as the object of a dotted, computed or
//       concatenated member);
//     * a STATIC import or re-export of "node:module" or "module", type-only
//       included;
//     * `process.getBuiltinModule`, dotted or with a literal computed key.
//
//   That lives in eslint.config.mjs and runs under `npm run lint` on every
//   diff. NC-lint below asserts the expected RULE ID fires for each example,
//   which shows those examples are rejected — not that the list is complete.
//
//   NOT covered by those rules, and therefore not claimed: `import("node:module")`
//   — core no-restricted-imports visits static declarations only — and
//   `globalThis.process.getBuiltinModule(...)` or an aliased `process`, since
//   no-restricted-properties matches only the literal `process` object. Those
//   are observations about the rules as configured today, not invariants: a
//   later lint change may start rejecting either, and nothing here defends the
//   gap.
//
// NOT CLAIMED
//
//   That arbitrary runtime module acquisition is impossible. It is not proven,
//   and this shape of evidence cannot prove it. Eleven of the seventeen modules
//   in the closure are shared infrastructure FIN does not own —
//   lib/supabase/server.ts alone has 96 importers — so no FIN-scoped coding
//   rule can bind them. For those, the money boundary is RLS and the owner
//   gate, not a source test.
//
// TYPE IMPORTS ARE FOLLOWED TOO. `import type` erases at runtime, so following
// it is stricter than the runtime graph — on purpose. The contract is about
// what this surface is COUPLED to, and `financial-spine.tsx` reached the money
// module through a type-only import alone.

/**
 * THE REPOSITORY'S OWN MODULE RESOLVER, not a hand-written approximation.
 *
 * A hand-rolled prober used to probe `x`, `x.ts`, `x.tsx`, `x/index.ts` by
 * hand, and missed that this repo compiles with `moduleResolution: "bundler"`,
 * under which `import "../dashboard/practice-metrics.js"` is a VALID import
 * resolving by extension substitution to the existing `.ts` file. The specifier
 * had been read perfectly; RESOLUTION is where the edge vanished.
 *
 * There is exactly ONE resolver in this file, and it is the compiler's.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const raw = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      `cannot read tsconfig.json, so module resolution cannot be trusted: ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`,
    );
  }
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT).options;
})();

const RESOLUTION_CACHE = ts.createModuleResolutionCache(ROOT, (x) => x, COMPILER_OPTIONS);

type Resolution =
  | { kind: "local"; file: string }
  | { kind: "external"; file: string }
  | { kind: "unresolved" };

/** Ask the compiler. Injectable ONLY so the fail-closed path can be proved. */
type Resolver = (specifier: string, fromFile: string) => Resolution;

const compilerResolver: Resolver = (specifier, fromFile) => {
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    fromFile,
    COMPILER_OPTIONS,
    ts.sys,
    RESOLUTION_CACHE,
  );
  if (!resolvedModule) return { kind: "unresolved" };
  const file = resolvedModule.resolvedFileName;
  // node_modules lives outside this worktree (it is shared), so a ROOT prefix
  // test would misclassify. The compiler's own flag is the answer.
  const external =
    resolvedModule.isExternalLibraryImport === true || file.includes("/node_modules/");
  return external ? { kind: "external", file } : { kind: "local", file };
};

/**
 * Every dependency-bearing site in a module, classified into exactly one state.
 * There is no fourth path and, in particular, no silent one.
 *
 *   RESOLVED_LOCAL      a project source file — traversed
 *   RESOLVED_EXTERNAL   an installed package — not our source, not our contract
 *   TYPE_ONLY           an erased dependency — ALSO traversed, on purpose
 *   UNRESOLVED          unreadable or unresolvable — a violation
 */
type SiteKind = "resolved_local" | "resolved_external" | "type_only" | "unresolved";

/** The AST form a site came from, for the census that proves none is lost. */
type SiteSyntax = "import" | "export-from" | "import-type" | "dynamic-import";

type DependencySite = {
  kind: SiteKind;
  syntax: SiteSyntax;
  detail: string;
  /** The literal specifier, when the site had a readable one. */
  specifier?: string;
  /** Present exactly when the site resolved. */
  file?: string;
};

/**
 * Whether an import or re-export is ERASED at emit, and so cannot execute the
 * module it names.
 *
 * Measured against this repository's options rather than assumed:
 * `verbatimModuleSyntax` is not set, so `import type { X } from "m"`,
 * `import { type X } from "m"`, `import type * as ns from "m"` and
 * `export type { X } from "m"` all emit nothing at all. A clause with NO named
 * bindings is not erased — `import "m"` and `import {} from "m"` both execute.
 */
const isErasedModuleReference = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
    }
    return false;
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  return false;
};

/**
 * ONE pass over a module's STATIC ESM dependency syntax.
 *
 * CommonJS is not analysed here at all any more — see the block comment above.
 * `require(...)` in a FIN-owned module is an ESLint error; in a shared module it
 * is outside what this file claims.
 */
function scanDependencies(
  source: string,
  fileName: string,
  resolver: Resolver = compilerResolver,
): DependencySite[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: DependencySite[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /**
   * The ONLY route into a resolved site. A non-literal specifier, or one the
   * compiler cannot resolve, becomes UNRESOLVED — never absent.
   */
  const dependency = (
    specifierNode: ts.Node | undefined,
    syntax: SiteSyntax,
    site: ts.Node,
    typeOnly: boolean,
  ) => {
    if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} — the specifier is not a literal, so it cannot be followed`,
      });
      return;
    }
    const specifier = specifierNode.text;
    const resolution = resolver(specifier, fileName);
    if (resolution.kind === "unresolved") {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} "${specifier}" — the compiler cannot resolve it`,
        specifier,
      });
      return;
    }
    sites.push({
      kind: typeOnly
        ? "type_only"
        : resolution.kind === "external"
          ? "resolved_external"
          : "resolved_local",
      syntax,
      detail: `line ${at(site)}: ${syntax} "${specifier}"`,
      specifier,
      file: resolution.file,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Side-effect imports land here too: no importClause, but a specifier.
      dependency(node.moduleSpecifier, "import", node, isErasedModuleReference(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // `export * as ns from "m"` included. A bare `export { a }` re-exports
      // nothing from elsewhere and is not a dependency site.
      dependency(node.moduleSpecifier, "export-from", node, isErasedModuleReference(node));
    } else if (ts.isImportTypeNode(node)) {
      dependency(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        "import-type",
        node,
        /* typeOnly */ true,
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `(import)("m")` is a PARSE ERROR — measured — so the callee needs no
      // normalisation. The ARGUMENT is where something can hide.
      dependency(node.arguments[0], "dynamic-import", node, /* typeOnly */ false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Local project files a module depends on, type-only edges included. */
function localTargets(sites: readonly DependencySite[]): string[] {
  const out: string[] = [];
  for (const site of sites) {
    const isLocal = site.kind === "resolved_local" || site.kind === "type_only";
    if (isLocal && site.file && !site.file.includes("/node_modules/")) out.push(site.file);
  }
  return out;
}

/** Dependency syntax that cannot be read or resolved. */
function violationsOf(sites: readonly DependencySite[]): string[] {
  return sites.filter((s) => s.kind === "unresolved").map((s) => s.detail);
}

const dependencySites = (file: string): DependencySite[] =>
  scanDependencies(readFileSync(file, "utf8"), file);

function dependencyViolations(source: string, fileName: string): string[] {
  return violationsOf(scanDependencies(source, fileName));
}

/** The literal specifiers a source names, whatever became of them. */
function specifiersOfSource(source: string, fileName: string): string[] {
  return scanDependencies(source, fileName)
    .map((site) => site.specifier)
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * file -> the importer that first reached it, so a failure names a chain.
 *
 * `sitesOf` is injectable so the fail-closed behaviour of a RESOLVER that
 * returns nothing for a perfectly readable literal can be tested. Production
 * callers take the default.
 */
function walkFrom(
  entries: readonly string[],
  sitesOf: (file: string) => DependencySite[] = dependencySites,
): Map<string, string | null> {
  const reached = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = entries.map((e) => [path.join(ROOT, e), null]);
  while (queue.length > 0) {
    const [file, via] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    for (const target of localTargets(sitesOf(file))) {
      if (!reached.has(target)) queue.push([target, path.relative(ROOT, file)]);
    }
  }
  return reached;
}

const FIN_ENTRIES = Object.values(FILES);
const CLOSURE = walkFrom(FIN_ENTRIES);
const CLOSURE_REL = [...CLOSURE.keys()].map((f) => path.relative(ROOT, f)).sort();

/**
 * The FIN-01A truth contract's banned identifiers, as *reachability* rules.
 * Service value, practitioner-attested settlement and Hone-verified money — the
 * three classes Slice 1 answers none of — plus the dormant and legacy decoys.
 */
const FORBIDDEN_ON_THE_PATH = [
  "price_cents",
  "price_paid_cents",
  "quoted_amount_cents",
  "amount_cents",
  "payment_charge_attempts",
  "appointment_settlements",
  "manual_fee_charge_attempts",
  "stripe_charge_attempts",
  "appointment_payments",
  "stripe_refunds",
  "stripe_refund_attempts",
  "charged_at",
  "refunded_at",
  "refund_status",
  "stripe_livemode",
  "inferStripeLivemode",
];

/**
 * ONE exemption, narrow enough to state in a sentence: a module that only
 * DECLARES the shape of a row names its columns, and naming a column is not
 * reading one. `lib/types/database.ts` is where `Studio` lives. The exemption
 * is not taken on trust — the assertion below proves the file still cannot
 * execute a read.
 */
const TYPE_DECLARATION_ONLY = new Set(["lib/types/database.ts"]);

/**
 * Every ESM shape the walker must see, with the answer WRITTEN DOWN rather than
 * computed. This is the one check that cannot go blind alongside the walker:
 * everything else in this block asks the extractor about the extractor.
 */
type Shape = [name: string, source: string, expected: string[]];

const MODULE_REFERENCE_SHAPES: Shape[] = [
  ["default import", 'import x from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["named import", 'import { known } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["namespace import", 'import * as ns from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["side-effect import", 'import "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-from", 'export { known } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-star", 'export * from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-star-as", 'export * as ns from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["dynamic import", 'const p = import("@/lib/finance/financial-fact");', ["@/lib/finance/financial-fact"]],
  ["dynamic import, template literal", "const p = import(`@/lib/finance/financial-fact`);", ["@/lib/finance/financial-fact"]],
  ["explicit .js specifier", 'import "@/lib/finance/financial-fact.js";', ["@/lib/finance/financial-fact.js"]],
  ["import type", 'import type { Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["inline type specifier", 'import { type Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export type from", 'export type { Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["import type position", 'type X = import("@/lib/finance/financial-fact").Fact<number>;', ["@/lib/finance/financial-fact"]],
  // ...and what must NOT become an edge.
  ["line-commented import", '// import "@/lib/finance/financial-fact";', []],
  ["block-commented import", '/* import "@/lib/finance/financial-fact"; */', []],
  ["a string that spells one", `const s = 'import "@/lib/finance/financial-fact"';`, []],
  ["a non-literal dynamic import", "const p = import(dynamicName);", []],
];

describe("NC-reach — the extractor sees every ESM module reference", () => {
  it.each(MODULE_REFERENCE_SHAPES)("%s", (_name, source, expected) => {
    expect(specifiersOfSource(source, path.join(ROOT, "lib/finance/probe.ts"))).toEqual(expected);
    expect(specifiersOfSource(source, path.join(ROOT, "lib/finance/probe.tsx"))).toEqual(expected);
  });

  it("an ESM edge is walked TRANSITIVELY, not just recognised at the entry", () => {
    // Recognising a specifier is half the job: the queue must also FOLLOW it.
    const CHAIN: Record<string, string> = {
      [FILES.model]: 'import "@/lib/finance/financial-copy";',
      "lib/finance/financial-copy.ts": 'import "@/lib/dashboard/practice-metrics";',
    };
    const reached = walkFrom([FILES.model], (file) =>
      scanDependencies(CHAIN[path.relative(ROOT, file)] ?? "", file),
    );
    expect([...reached.keys()].map((f) => path.relative(ROOT, f))).toEqual([
      FILES.model,
      "lib/finance/financial-copy.ts",
      "lib/dashboard/practice-metrics.ts",
    ]);
  });

  it("THE MONEY MODULE: an ESM edge to it resolves, and it really is a money path", () => {
    const entry = path.join(ROOT, FILES.model);
    const specs = specifiersOfSource('import "@/lib/dashboard/practice-metrics";', entry);
    expect(specs).toEqual(["@/lib/dashboard/practice-metrics"]);

    const resolution = compilerResolver(specs[0], entry);
    expect(resolution.kind).toBe("local");
    expect(
      resolution.kind === "local" ? path.relative(ROOT, resolution.file) : resolution.kind,
    ).toBe("lib/dashboard/practice-metrics.ts");

    const money = codeOnly(read("lib/dashboard/practice-metrics.ts"));
    expect(FORBIDDEN_ON_THE_PATH.filter((id) => money.includes(id))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Static dependencies fail closed
// ---------------------------------------------------------------------------

describe("NC-static — an unreadable or unresolvable dependency is a violation", () => {
  const probe = path.join(ROOT, "lib/finance/probe.ts");

  it.each([
    ['import("@/lib/dashboard/" + "practice-metrics");', "concatenated specifier"],
    ['const s = "@/lib/dashboard/practice-metrics"; import(s);', "variable specifier"],
    ['import(c ? "./a" : "@/lib/dashboard/practice-metrics");', "conditional specifier"],
    ["import(`@/lib/dashboard/${name}`);", "substituted template"],
  ])("%s is UNRESOLVED, not absent", (source) => {
    const sites = scanDependencies(source, probe);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(violationsOf(sites).join(" ")).toMatch(/not a literal/);
    expect(localTargets(sites)).toEqual([]);
  });

  it("NO CONSTANT FOLDING: a concatenation naming a SAFE module is rejected too", () => {
    // Legibility is the rule, not the destination. Folding would be the first
    // step back towards interpreting JavaScript.
    const sites = scanDependencies('import("@/lib/finance/" + "financial-fact");', probe);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
  });

  it("a literal the compiler cannot resolve is a violation", () => {
    for (const source of ['import "@/lib/does/not/exist";', 'import "./nope/nowhere";']) {
      const sites = scanDependencies(source, probe);
      expect(sites.map((s) => s.kind), source).toEqual(["unresolved"]);
      expect(violationsOf(sites).join(" ")).toMatch(/cannot resolve/);
    }
  });

  it("EVERY SITE HAS EXACTLY ONE KIND", () => {
    const kindsOf = (source: string) => scanDependencies(source, probe).map((s) => s.kind);
    expect(kindsOf('import "@/lib/finance/financial-fact";')).toEqual(["resolved_local"]);
    expect(kindsOf('import * as React from "react";')).toEqual(["resolved_external"]);
    expect(kindsOf('import type { Fact } from "@/lib/finance/financial-fact";')).toEqual([
      "type_only",
    ]);
    expect(kindsOf("import(x);")).toEqual(["unresolved"]);
    expect(kindsOf('import "@/lib/does/not/exist";')).toEqual(["unresolved"]);

    const mixed = scanDependencies(
      [
        'import "@/lib/finance/financial-fact";',
        'import * as React from "react";',
        'import type { Fact } from "@/lib/finance/financial-copy";',
        "import(x);",
      ].join("\n"),
      probe,
    );
    expect(mixed.map((s) => s.kind).sort()).toEqual(
      ["resolved_external", "resolved_local", "type_only", "unresolved"].sort(),
    );
    expect(mixed).toHaveLength(4);
  });

  it("NO MODULE IN THE FIN CLOSURE HAS AN UNREADABLE DEPENDENCY", () => {
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      for (const violation of dependencyViolations(readFileSync(file, "utf8"), file)) {
        offences.push(`${rel} ${violation} (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("LOAD-BEARING: a recognised literal the resolver cannot resolve turns the guard RED", () => {
    // Extraction succeeds and only RESOLUTION fails — the stage that used to
    // produce silence. A resolver that resolves nothing stands in for the
    // hand-written prober that could not follow `practice-metrics.js`.
    const blindResolver: Resolver = () => ({ kind: "unresolved" });
    const sites = scanDependencies('import "@/lib/finance/financial-fact";', probe, blindResolver);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(localTargets(sites)).toEqual([]);

    const reached = walkFrom(FIN_ENTRIES, (file) =>
      scanDependencies(readFileSync(file, "utf8"), file, blindResolver),
    );
    expect(reached.size).toBe(FIN_ENTRIES.length);

    // The real resolver, on the same tree, produces no violation at all.
    expect(violationsOf(dependencySites(path.join(ROOT, FILES.model)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. The money-path closure
// ---------------------------------------------------------------------------

describe("NC-reach — no money path is in FIN Slice 1's static ESM closure", () => {
  it("ANTI-VACUITY: the walk actually resolved a real graph", () => {
    expect(CLOSURE.size).toBeGreaterThanOrEqual(12);
    expect(CLOSURE_REL).toContain("lib/booking/reporting-period.ts");
    expect(CLOSURE_REL).toContain("lib/booking/tz.ts");
    expect(CLOSURE_REL).toContain("lib/supabase/queries.ts");
    expect(CLOSURE_REL).toContain("lib/types/database.ts");
  });

  it("CLOSURE IS CLOSED: every local edge of a reached file is itself reached", () => {
    const escaped: string[] = [];
    for (const file of CLOSURE.keys()) {
      for (const target of localTargets(dependencySites(file))) {
        if (!CLOSURE.has(target)) {
          escaped.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it("THE MONEY MODULE is not in the closure", () => {
    expect(CLOSURE_REL).not.toContain("lib/dashboard/practice-metrics.ts");
    expect(CLOSURE_REL.filter((f) => f.startsWith("lib/dashboard/"))).toEqual([]);
  });

  it("no module in the closure contains a forbidden identifier", () => {
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      if (TYPE_DECLARATION_ONLY.has(rel)) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      for (const id of FORBIDDEN_ON_THE_PATH) {
        if (code.includes(id)) {
          offences.push(`${rel} contains "${id}" (reached via ${via ?? "entry point"})`);
        }
      }
    }
    expect(offences).toEqual([]);
  });

  it("the type-declaration exemption cannot hide a read", () => {
    for (const rel of TYPE_DECLARATION_ONLY) {
      const code = codeOnly(readFileSync(path.join(ROOT, rel), "utf8"));
      expect(code, rel).not.toMatch(/\.from\(|\.rpc\(|createClient|supabase/i);
      for (const line of code.split("\n")) {
        if (/^\s*import\s/.test(line)) {
          expect(line, `${rel}: ${line.trim()}`).toMatch(/^\s*import type\s/);
        }
      }
    }
  });

  it("TOTAL equals the sum of the kinds, for every module in the closure", () => {
    // A site that fell through to nothing would make the parts sum to less than
    // the whole.
    for (const file of CLOSURE.keys()) {
      const sites = dependencySites(file);
      const sum =
        sites.filter((s) => s.kind === "resolved_local").length +
        sites.filter((s) => s.kind === "resolved_external").length +
        sites.filter((s) => s.kind === "type_only").length +
        sites.filter((s) => s.kind === "unresolved").length;
      expect(sum, path.relative(ROOT, file)).toBe(sites.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. The FIN-owned coding constraint, and exactly what it covers
// ---------------------------------------------------------------------------
//
// This is the OTHER half of the architecture, and it is a CONSTRAINT rather
// than a proof. In app/(app)/financials/** and lib/finance/**, eslint.config.mjs
// configures three rules, whose families are:
//
//   * a value-position `require`, `module` or `exports`, in any expression
//     shape;
//   * a STATIC import or re-export of "node:module" or "module", type-only
//     included;
//   * `process.getBuiltinModule`, dotted or with a literal computed key.
//
// `npm run lint` runs it on every diff.
//
// These rules are a coding constraint. They are not a complete runtime-loader
// proof, not a security boundary, and not a claim about every way JavaScript
// can acquire a module.
//
// Tested here for one reason: a lint rule nobody exercises is a comment. Each
// assertion below names the RULE it expects, so a control cannot pass because
// some unrelated rule happened to fire on the fixture.
//
// The scope is honest and narrow. These rules bind app/(app)/financials/** and
// lib/finance/** — the six modules FIN owns. The other eleven in the closure
// are shared infrastructure, and a test below proves the rules do NOT reach
// them, so nobody mistakes this for a repository-wide boundary.

const FIN_OWNED_PROBE = path.join(ROOT, "lib/finance/__lint_probe.ts");
const SHARED_PROBE = path.join(ROOT, "lib/booking/__lint_probe.ts");

/** Rule ids ESLint reports for a source, without writing anything to disk. */
async function lintRuleIds(source: string, filePath: string): Promise<string[]> {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? [])
    .map((m) => m.ruleId)
    .filter((id): id is string => id !== null);
}

describe("NC-lint — the configured rules reject these FIN-owned loader forms", () => {
  // One fixture per form, asserted BY RULE ID so a control cannot pass because
  // some unrelated rule fired on the fixture. These prove the listed forms ARE
  // rejected; they do not prove that nothing else can acquire a module.
  it.each([
    // no-restricted-globals: any value-position use, whatever the shape.
    ["require, called", 'export const a = require("x");', "no-restricted-globals"],
    ["require, aliased", "export const a = require;", "no-restricted-globals"],
    ["require, parenthesized", 'export const a = (require)("x");', "no-restricted-globals"],
    ["require, instantiated", 'export const a = ((require as <T>(i: string) => T)<string>)("x");', "no-restricted-globals"],
    ["require, conditional", 'declare const f: boolean;\nexport const a = (f ? require : require)("x");', "no-restricted-globals"],
    ["require, comma sequence", 'export const a = (0, require)("x");', "no-restricted-globals"],
    ["module, dotted member", 'export const a = module.require("x");', "no-restricted-globals"],
    ["module, computed member", 'export const a = module["require"]("x");', "no-restricted-globals"],
    ["module, concatenated key", 'export const a = module["requ" + "ire"]("x");', "no-restricted-globals"],
    ["module, bare reference", "export const a = module;", "no-restricted-globals"],
    ["exports, assigned", "exports.x = 1;", "no-restricted-globals"],
    // no-restricted-imports: STATIC forms only, type-only included.
    ["static named import", 'import { createRequire } from "node:module";\nexport const a = createRequire;', "no-restricted-imports"],
    ["static renamed import", 'import { createRequire as cr } from "node:module";\nexport const a = cr;', "no-restricted-imports"],
    ["static namespace import", 'import * as nm from "node:module";\nexport const a = nm;', "no-restricted-imports"],
    ["static default import", 'import nm from "node:module";\nexport const a = nm;', "no-restricted-imports"],
    ["static side-effect import", 'import "node:module";', "no-restricted-imports"],
    ["static import of bare module", 'import m from "module";\nexport const a = m;', "no-restricted-imports"],
    ["re-export from node:module", 'export { createRequire } from "node:module";', "no-restricted-imports"],
    ["type-only import", 'import type { RequireResolve } from "node:module";\nexport type A = RequireResolve;', "no-restricted-imports"],
    // no-restricted-properties: the literal `process` object.
    ["process.getBuiltinModule", 'export const a = process.getBuiltinModule("module");', "no-restricted-properties"],
    ['process["getBuiltinModule"]', 'export const a = process["getBuiltinModule"]("module");', "no-restricted-properties"],
  ])("%s is rejected in FIN-owned source", async (_name, source, expectedRule) => {
    const ruleIds = await lintRuleIds(source, FIN_OWNED_PROBE);
    expect(ruleIds, `${source} -> ${ruleIds.join(", ")}`).toContain(expectedRule);
  });

  it("a locally bound `require` is correctly NOT flagged", async () => {
    // Not a gap: a parameter named `require` is a local binding, not the
    // loader. Flagging it would be a false positive, and no-restricted-globals
    // is right to ignore it.
    const ruleIds = await lintRuleIds(
      'export function f(require: (i: string) => unknown) { return require("x"); }',
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).not.toContain("no-restricted-globals");
  });

  it("approved FIN ESM source stays clean", async () => {
    const ruleIds = await lintRuleIds(
      'import { known } from "@/lib/finance/financial-fact";\nexport const a = known(1);\n',
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).toEqual([]);
  });

  it("an object KEY named require or module is not a use of one", async () => {
    const ruleIds = await lintRuleIds(
      "export const o = { require: 1, module: 2 };",
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).toEqual([]);
  });

  it("SCOPE IS NARROW, and the limit is stated rather than hidden", async () => {
    // Eleven of the seventeen modules in CLOSURE are shared, so this constraint
    // covers six. Asserted so the claim cannot quietly widen.
    const ruleIds = await lintRuleIds(
      'import * as nm from "node:module";\nexport const a = nm;',
      SHARED_PROBE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("FIN-owned source contains none of these today", async () => {
    for (const rel of FIN_ENTRIES) {
      const ruleIds = await lintRuleIds(read(rel), path.join(ROOT, rel));
      expect(ruleIds, rel).toEqual([]);
    }
  });
});
