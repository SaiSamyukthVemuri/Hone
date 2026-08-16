import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring guards for the inventory-backed probe-lot selector (Chloe item #9,
// migration 0155). Behaviour is proven in the pure unit tests + DB/RLS + E2E;
// these pins lock the source contract: canonical inventory table, studio
// isolation, probe-SPECIFIC via probe_key, durable id link + snapshot, manual
// entry always available, dormant tables avoided.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("server query: authoritative source + probe-specific + studio isolation", () => {
  const QUERIES = read("lib/record-keeping/queries.ts");

  it("getProbeLotInventory reads record_keeping_sterile_items (not dormant probe_lots/probe_lot_id)", () => {
    const fn = QUERIES.slice(QUERIES.indexOf("export async function getProbeLotInventory"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/\.from\("record_keeping_sterile_items"\)/);
    expect(body).not.toMatch(/probe_lots/);
    expect(body).not.toMatch(/probe_lot_id/);
  });

  it("(0155) selects the id + probe_key, is studio-scoped, and filters to probe-classified rows with a lot", () => {
    const fn = QUERIES.slice(QUERIES.indexOf("export async function getProbeLotInventory"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/"id, probe_key, lot_number/);
    expect(body).toMatch(/\.eq\("studio_id", studioId\)/);
    // Probe-SPECIFIC via structured probe_key, NOT the free-text ILIKE heuristic.
    expect(body).toMatch(/\.not\("probe_key", "is", null\)/);
    expect(body).not.toMatch(/\.ilike\("item_description"/);
    expect(body).toMatch(/\.not\("lot_number", "is", null\)/);
  });

  it("(0182 / Finding C) the WIRING is pinned: lockstep ids, both maps, fail-closed mapping", () => {
    // The auto-fill guard itself is mutation-proven in
    // tests/lib/record-keeping/sterile-item-discard-lifecycle.test.ts. These
    // assertions cover the part a resolver test structurally cannot: the
    // production reducer in getProbeLotSuggestions that FEEDS it. Verified
    // mutation-sensitive — before these existed, deleting the lockstep
    // assignment or flipping the read-error mapping to "current" left the
    // entire 7,583-test unit suite green while reopening the fail-closed
    // contract.
    const fn = QUERIES.slice(
      QUERIES.indexOf("export async function getProbeLotSuggestions"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");

    // 1. The charted inventory id is recorded in LOCKSTEP with lastCharted, so
    //    the id always describes the row the lot number came from.
    expect(code).toMatch(/map\[slot\]\.lastCharted = lot;/);
    expect(code).toMatch(
      /map\[slot\]\.lastChartedInventoryItemId = inventoryItemId;/,
    );

    // 2. BOTH maps are covered. byLabel is the legacy-row path; leaving it out
    //    would silently exempt every studio whose rows have no probe_key.
    expect(code).toMatch(/seedLastCharted\(\s*byKey,/);
    expect(code).toMatch(/seedLastCharted\(\s*byLabel,/);
    expect(code).toMatch(
      /\[\.\.\.Object\.values\(byKey\), \.\.\.Object\.values\(byLabel\)\]/,
    );

    // 3. FAIL CLOSED. A failed authority read maps every id to "unknown",
    //    NEVER to "current" — the guard must refuse, not be handed permission.
    expect(code).toMatch(/lifecycle\.ok[\s\S]{0,160}:\s*"unknown"/);
    expect(code).not.toMatch(/lifecycle\.ok[\s\S]{0,160}:\s*"current"/);

    // 4. A manual charted row (no inventory id) is skipped entirely, so it
    //    stays `null` and is never mistaken for "unknown" — otherwise every
    //    zero-inventory studio would lose its manual history suggestion.
    expect(code).toMatch(/if \(!id\) continue;/);
  });

  it("(0182 / Finding C) the lifecycle AUTHORITY read applies none of the picker's filters", () => {
    // Supplementary source evidence for the behavioural DB coverage in
    // tests/db/sterile-item-discard-lifecycle.db.test.ts. The whole point of
    // getInventoryLifecycleByIds is that it is identity-complete: if it ever
    // inherits the picker's probe_key / lot_number / 500-row constraints, a
    // discarded item can vanish from it again and the auto-fill guard silently
    // fails OPEN — which is exactly the defect this function was added to fix.
    const fn = QUERIES.slice(
      QUERIES.indexOf("export async function getInventoryLifecycleByIds"),
    );
    expect(fn.length).toBeGreaterThan(0);
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Identity-keyed and studio-scoped...
    expect(code).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(code).toMatch(/\.in\("id", unique\)/);
    // ...returning ONLY lifecycle facts...
    expect(code).toMatch(/\.select\("id, expiry_date, date_discarded"\)/);
    // ...with NONE of the picker's narrowing filters or bound.
    expect(code).not.toMatch(/probe_key/);
    expect(code).not.toMatch(/lot_number/);
    expect(code).not.toMatch(/\.limit\(/);
    // Never elevated: the user-scoped client only, so RLS still applies.
    expect(code).not.toMatch(/service_role|admin/i);
    // Fail-closed: a read error is reported, never swallowed into an empty map.
    expect(code).toMatch(/if \(error\) return \{ ok: false \}/);
  });

  it("(0182) SELECTS date_discarded but never FILTERS on it — the foundational read", () => {
    const fn = QUERIES.slice(
      QUERIES.indexOf("export async function getProbeLotInventory"),
    );
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const code = body
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // Carried through onto the option model...
    expect(code).toMatch(/date_discarded/);
    expect(code).toMatch(/dateDiscarded: r\.date_discarded/);
    // ...and NOT used as a query predicate. This is the architecture law: a
    // historical session's probe_inventory_item_id, the edit chooser for that
    // old record, and lot traceability ALL resolve through this list, so a row
    // that vanished here would take retrospective truth with it.
    expect(code).not.toMatch(/\.is\("date_discarded"/);
    expect(code).not.toMatch(/\.not\("date_discarded"/);
  });
});

describe("selector component: id identity, manual entry, expired handling", () => {
  const SELECT = read("components/probe-lot-select.tsx");

  it("always renders an editable text input; typing calls onManualChange and clears the link", () => {
    expect(SELECT).toMatch(/data-testid="probe-lot-input"/);
    expect(SELECT).toMatch(/onManualChange\(e\.target\.value\)/);
  });

  it("(0155) selection emits the inventory option and keys/selects by inventory id (not lot number)", () => {
    expect(SELECT).toMatch(/onSelectInventory\(o\)/);
    expect(SELECT).toMatch(/key=\{o\.id\}/);
    expect(SELECT).toMatch(/aria-selected=\{selectedInventoryItemId === o\.id\}/);
    expect(SELECT).toMatch(/data-testid=\{`probe-lot-option-\$\{o\.id\}`\}/);
  });

  it("shows linked/manual badges + the probe-specific empty state", () => {
    expect(SELECT).toMatch(/Inventory linked/);
    expect(SELECT).toMatch(/Manual entry, not linked to inventory/);
    expect(SELECT).toMatch(/No active inventory lot for this probe/);
  });

  it("links to the probe inventory and flags expired lots; large tap targets; blur-safe select", () => {
    expect(SELECT).toMatch(/inventoryHref/);
    expect(SELECT).toMatch(/Manage probe inventory/);
    expect(SELECT).toMatch(/Expired/);
    expect(SELECT).toMatch(/onMouseDown=/);
    expect(SELECT).toMatch(/min-h-\[2\.75rem\]/);
  });

  it("(0182) the default shortlist is CURRENT STOCK, via the SHARED predicate", () => {
    // The shortlist must not re-implement "usable now" locally. It previously
    // read `options.filter((o) => !o.isExpired)`; if that inline predicate
    // returned, a discarded lot would silently reappear as current stock in the
    // chooser while every server-side selector excluded it.
    expect(SELECT).toMatch(/options\.filter\(isCurrentStock\)/);
    expect(SELECT).toMatch(
      /import \{[\s\S]{0,200}isCurrentStock,[\s\S]{0,200}\} from "@\/lib\/record-keeping\/probe-lot-inventory"/,
    );
    expect(SELECT).not.toMatch(/options\.filter\(\(o\) => !o\.isExpired\)/);
  });

  it("(0182) a discarded lot is LABELLED and remains findable by typing", () => {
    // Two halves of the same contract. The badge stops it being mistaken for
    // current stock; the typed-search fallback (`const base = q ? options :
    // active`) is what keeps a prior session's since-discarded lot resolvable
    // for retrospective charting.
    expect(SELECT).toMatch(/o\.isDiscarded &&/);
    expect(SELECT).toMatch(/>\s*Discarded\s*</);
    expect(SELECT).toMatch(/const base = q \? options : active/);
  });
});

describe("form wiring: durable link + snapshot (no dormant FK)", () => {
  const FORM = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  );

  it("(0155) renders ProbeLotSelect bound to the probe-specific options + the link id", () => {
    expect(FORM).toMatch(/<ProbeLotSelect/);
    expect(FORM).toMatch(/value=\{draft\.probeLotNumber\}/);
    expect(FORM).toMatch(/selectedInventoryItemId=\{draft\.probeInventoryItemId\}/);
    expect(FORM).toMatch(/options=\{probeOptions\}/);
    expect(FORM).toMatch(/inventoryHref="\/records\?section=sterile"/);
  });

  it("submits the inventory item id + never uses the dormant probe_lot_id", () => {
    expect(FORM).toMatch(/probeInventoryItemId: draft\.probeInventoryItemId/);
    expect(FORM).not.toMatch(/probe_lot_id/);
  });

  it("selecting/typing a lot marks manual/link state so a probe switch behaves correctly", () => {
    // Provenance is per-probe: BOTH an explicit inventory pick and a typed
    // value bind the lot to the probe selected at that moment, so neither can
    // follow the practitioner onto a different probe.
    expect(FORM).toMatch(/setLotOwnerProbeKey\(draft\.probeKey\);/);
    expect(FORM).not.toMatch(/setLotEditedManually/);
  });
});

describe("page + view thread the inventory through to the form", () => {
  const PAGE = read("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx");
  const VIEW = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/session-blocks-view.tsx",
  );
  it("the session page loads the inventory for electrolysis and passes it down", () => {
    expect(PAGE).toMatch(/getProbeLotInventory\(studio\.id\)/);
    expect(PAGE).toMatch(/probeLotInventory=\{probeLotInventory\}/);
  });
  it("the view forwards probeLotInventory to every BlockSetupForm mount", () => {
    expect(VIEW).toMatch(/probeLotInventory=\{probeLotInventory\}/);
  });
});
