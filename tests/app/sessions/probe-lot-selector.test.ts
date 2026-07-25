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
    expect(body).toMatch(/\.select\("id, probe_key, lot_number/);
    expect(body).toMatch(/\.eq\("studio_id", studioId\)/);
    // Probe-SPECIFIC via structured probe_key, NOT the free-text ILIKE heuristic.
    expect(body).toMatch(/\.not\("probe_key", "is", null\)/);
    expect(body).not.toMatch(/\.ilike\("item_description"/);
    expect(body).toMatch(/\.not\("lot_number", "is", null\)/);
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
    expect(SELECT).toMatch(/Manual entry — not linked to inventory/);
    expect(SELECT).toMatch(/No active inventory lot for this probe/);
  });

  it("links to the probe inventory and flags expired lots; large tap targets; blur-safe select", () => {
    expect(SELECT).toMatch(/inventoryHref/);
    expect(SELECT).toMatch(/Manage probe inventory/);
    expect(SELECT).toMatch(/Expired/);
    expect(SELECT).toMatch(/onMouseDown=/);
    expect(SELECT).toMatch(/min-h-\[2\.75rem\]/);
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
    expect(FORM).toMatch(/setLotEditedManually\(value\.trim\(\) !== ""\)/);
    expect(FORM).toMatch(/setLotEditedManually\(false\)/); // an inventory select is NOT manual
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
