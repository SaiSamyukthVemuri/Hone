import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #316 (Chloe feedback): manufacturer dropdown (Protec/Ballet/Sterex/Other),
// copy-last (never copies the lot number), expiry states in Records, and a
// studio-scoped "Supplies expiring" dashboard card. Source-grep (these are RSC/
// client UI); the pure expiry logic is unit-tested in supply-expiry.test.ts.

const root = path.resolve(__dirname, "../../../");
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");

const FORMS = read("app/(app)/records/record-forms.tsx");
const PAGE = read("app/(app)/records/page.tsx");
const QUERIES = read("lib/record-keeping/queries.ts");
const DASH = read("app/(app)/dashboard/page.tsx");
const CARD = read("app/(app)/dashboard/supplies-expiring.tsx");
const PRINT = read("app/(app)/records/print/page.tsx");
const EXPORT = read("app/(app)/settings/data/actions.ts");

describe("manufacturer dropdown", () => {
  it("offers Protec / Ballet / Sterex + Other", () => {
    expect(FORMS).toMatch(/MANUFACTURER_OPTIONS\s*=\s*\[\s*"Protec",\s*"Ballet",\s*"Sterex"\s*\]/);
    expect(FORMS).toMatch(/Other \(type a name\)/);
    expect(FORMS).toMatch(/function ManufacturerPicker/);
  });
  it("submits exactly one manufacturer_name (hidden input; select is unnamed)", () => {
    expect(FORMS).toMatch(/<input type="hidden" name="manufacturer_name" value=\{resolved\}/);
    // no <select> carries name="manufacturer_name" (no collision), and the only
    // manufacturer_name form control is the single hidden input.
    expect(FORMS).not.toMatch(/<select[^>]*name="manufacturer_name"/);
    expect((FORMS.match(/name="manufacturer_name"/g) ?? []).length).toBe(1);
  });
  it("preserves a custom/legacy value on edit (Other + prefilled text)", () => {
    const s = FORMS.indexOf("function ManufacturerPicker");
    const body = FORMS.slice(s, s + 1600);
    // known -> preselect brand; non-empty non-known -> OTHER + custom text
    expect(body).toMatch(/OTHER_MANUFACTURER/);
    expect(body).toMatch(/defaultValue && !known/);
    // Edit form wires the stored value into the picker
    expect(FORMS).toMatch(/<ManufacturerPicker defaultValue=\{record\.manufacturer_name\}/);
  });
});

describe("copy-last never copies the lot number", () => {
  it("SterileCopyLast type has no lot_number field", () => {
    const s = FORMS.indexOf("export type SterileCopyLast");
    const body = FORMS.slice(s, s + 300);
    expect(body).not.toMatch(/lot_number/);
  });
  it("the Add form's copied Lot # field has no prefill defaultValue", () => {
    // The lot field stays a plain placeholder input — never fed from prefill.
    expect(FORMS).toMatch(/label="Lot #" name="lot_number" placeholder="e\.g\. 460941"/);
    expect(FORMS).not.toMatch(/name="lot_number"[^>]*defaultValue=\{prefill/);
  });
  it("page passes lastRecord WITHOUT a lot_number field", () => {
    const s = PAGE.indexOf("lastRecord={");
    const body = PAGE.slice(s, s + 600);
    expect(body).toMatch(/date_purchased: records\[0\]\.date_purchased/);
    expect(body).toMatch(/expiry_date: records\[0\]\.expiry_date/);
    // No lot_number KEY in the copied object (a comment may mention the word).
    expect(body).not.toMatch(/lot_number:/);
  });
});

describe("Records page expiry states + banner", () => {
  it("computes state per row and styles expired red / expiring amber with a helper-driven badge", () => {
    expect(PAGE).toMatch(/supplyExpiryState\(r\.expiry_date, today\)/);
    // Badge text comes from supplyExpiryLabel (one source of truth incl. the
    // PR #317 "Expires today" state) — not hardcoded literals in the page.
    expect(PAGE).toMatch(/supplyExpiryLabel\(expiry\)/);
    expect(PAGE).toMatch(/\{expiryLabel\}/);
    expect(PAGE).toMatch(/bg-red-50/);
    expect(PAGE).toMatch(/bg-amber-50/);
    // "today" and "expiring" share the amber row treatment.
    expect(PAGE).toMatch(/expiry === "today" \|\| expiry === "expiring"/);
  });
  it("shows a summary banner with expired + expiring-within-30 counts", () => {
    expect(PAGE).toMatch(/summarizeSupplyExpiry\(records, today\)/);
    expect(PAGE).toMatch(/expiring within 30 days/);
    expect(PAGE).toMatch(/\$\{expirySummary\.expired\} expired/);
  });
  it("uses studio-local today", () => {
    expect(PAGE).toMatch(/const today = todayInTz\(timezone\)/);
  });
});

describe("dashboard 'Supplies expiring' card is studio-scoped", () => {
  it("the query filters by studio_id and returns no lot_number", () => {
    const s = QUERIES.indexOf("export async function getExpiringSterileItems");
    const body = QUERIES.slice(s, s + 900);
    expect(body).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(body).toMatch(/\.not\("expiry_date", "is", null\)/);
    expect(body).toMatch(/\.lte\("expiry_date", horizon\)/);
    expect(body).not.toMatch(/lot_number/);
  });
  it("dashboard fetches it scoped to the current studio + renders the card", () => {
    expect(DASH).toMatch(/getExpiringSterileItems\(studio\.id, todayLocal\)/);
    expect(DASH).toMatch(/<SuppliesExpiringCard items=\{expiringSupplies\} today=\{todayLocal\}/);
  });
  it("the card renders nothing when empty (no clutter) and never shows lot numbers", () => {
    expect(CARD).toMatch(/if \(items\.length === 0\) return null/);
    expect(CARD).not.toMatch(/lot_number/);
  });
});

describe("PR #317: print expiry marker + export note", () => {
  it("SterilePrint appends a studio-local, print-safe expiry marker to the date", () => {
    expect(PRINT).toMatch(/supplyExpiryPrintMarker\(r\.expiry_date, today\)/);
    expect(PRINT).toMatch(/const today = todayInTz\(timezone\)/);
    expect(PRINT).toMatch(/<SterilePrint[\s\S]{0,120}timezone=\{studio\.timezone\}/);
    // Marker only when an expiry date is recorded (no marker for null).
    expect(PRINT).toMatch(/r\.expiry_date\s*\?\s*`\$\{dateOnly\(r\.expiry_date\)\}\$\{supplyExpiryPrintMarker/);
  });
  it("the export README notes expiry is derivable from expiry_date (no CSV schema change)", () => {
    expect(EXPORT).toMatch(/Expiry status is derivable from the expiry_date column/);
    // CSV header still carries the same columns (schema unchanged).
    expect(EXPORT).toMatch(/"expiry_date",/);
  });
});

describe("no migration / schema / RLS change", () => {
  it("the new getExpiringSterileItems query adds no DDL/RPC (plain scoped select)", () => {
    const s = QUERIES.indexOf("export async function getExpiringSterileItems");
    const body = QUERIES.slice(s, s + 900);
    expect(body).not.toMatch(/alter table|create table|create policy|drop policy|\.rpc\(/i);
  });
  it("the new expiry helper + dashboard card contain no DB/DDL at all", () => {
    const EXPIRY = read("lib/record-keeping/expiry.ts");
    for (const src of [EXPIRY, CARD]) {
      expect(src).not.toMatch(/alter table|create table|create policy|drop policy|\.rpc\(|\.from\(/i);
    }
  });
});
