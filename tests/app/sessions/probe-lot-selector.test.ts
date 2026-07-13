import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Wiring guards for the active probe-lot inventory selector (migration 0128
// charting release). The behaviour is proven in the pure unit tests + the E2E;
// these pins lock the source contract: real source table, studio isolation,
// manual entry always available, snapshot save (no FK), and dormant-table avoid.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("server query: authoritative source + studio isolation", () => {
  const QUERIES = read("lib/record-keeping/queries.ts");

  it("getProbeLotInventory reads record_keeping_sterile_items (not dormant probe_lots)", () => {
    const fn = QUERIES.slice(QUERIES.indexOf("export async function getProbeLotInventory"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/\.from\("record_keeping_sterile_items"\)/);
    expect(body).not.toMatch(/probe_lots/);
  });

  it("is studio-scoped and filtered to probe rows with a lot number", () => {
    const fn = QUERIES.slice(QUERIES.indexOf("export async function getProbeLotInventory"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    expect(body).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(body).toMatch(/\.ilike\("item_description", "%probe%"\)/);
    expect(body).toMatch(/\.not\("lot_number", "is", null\)/);
  });
});

describe("selector component: manual entry, empty state, inventory link", () => {
  const SELECT = read("components/probe-lot-select.tsx");

  it("always renders an editable text input (manual entry never removed)", () => {
    expect(SELECT).toMatch(/data-testid="probe-lot-input"/);
    expect(SELECT).toMatch(/onChange=\{\(e\) =>/);
    // Typing calls onChange directly — a typed value is never auto-replaced.
    expect(SELECT).toMatch(/onChange\(e\.target\.value\)/);
  });

  it("shows a 'No active probe lots found' empty state", () => {
    expect(SELECT).toMatch(/No active probe lots found/);
    expect(SELECT).toMatch(/data-testid="probe-lot-empty"/);
  });

  it("links to the probe inventory and flags expired lots", () => {
    expect(SELECT).toMatch(/inventoryHref/);
    expect(SELECT).toMatch(/Manage probe inventory/);
    expect(SELECT).toMatch(/Expired/);
  });

  it("selection uses onMouseDown so a tap registers before blur (iPad-friendly)", () => {
    expect(SELECT).toMatch(/onMouseDown=/);
    expect(SELECT).toMatch(/min-h-\[2\.75rem\]/); // large tap targets
  });
});

describe("form wiring: snapshot save on the existing free-text field (no FK)", () => {
  const FORM = read(
    "app/(app)/clients/[id]/sessions/[sessionId]/block-setup-form.tsx",
  );

  it("renders ProbeLotSelect bound to the probe-lot snapshot field", () => {
    expect(FORM).toMatch(/<ProbeLotSelect/);
    expect(FORM).toMatch(/value=\{draft\.probeLotNumber\}/);
    expect(FORM).toMatch(/options=\{probeLotInventory\}/);
    expect(FORM).toMatch(/inventoryHref="\/records\?section=sterile"/);
  });

  it("still persists the lot number as a free-text snapshot (no probe_lot_id FK)", () => {
    expect(FORM).toMatch(/probeLotNumber: draft\.probeLotNumber\.trim\(\) \|\| null/);
    expect(FORM).not.toMatch(/probe_lot_id/);
  });

  it("selecting/typing a lot marks a manual edit so a probe switch never clobbers it", () => {
    expect(FORM).toMatch(/setLotEditedManually\(value\.trim\(\) !== ""\)/);
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
