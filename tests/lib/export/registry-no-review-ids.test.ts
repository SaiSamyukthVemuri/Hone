import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EXPORT_RESOURCE_REGISTRY, pendingColumns, pendingResources } from "@/lib/export/resource-registry";

// The registry's reasons and column notes are printed on the Data settings page and written into the export's own README and manifest
// (settings/data/page.tsx and actions.ts read `disposition.reason`). They are customer-visible text, so they state the rule and never carry
// a review thread id, a review label, an internal ticket id or a person's first name.
// SCOPE: this guards every string in the export registry (reasons, column notes, count-check notes), the README line and manifest row the
// export action builds, and the page and action source. It does not scan other screens or other files of the export.
// The names below are plain test data (the people this project's review threads and notes have named); they are never rendered.
const KNOWN_FIRST_NAMES = ["Sam", "Sabrina", "Chloe"];
const NAME = new RegExp(`\\b(?:${KNOWN_FIRST_NAMES.join("|")})\\b`);
const TICKET_IDS = /\bHON-\d|\bTRUTH-/;
const REVIEW_MARKERS = new RegExp(`\\bCodex\\b|\\bInsurance\\b|\\bPrivacy [A-Z]|\\bOPS\\b|\\bPhotos R\\d|\\d{9,}|${NAME.source}`);

describe("the export registry's customer-visible text carries no review ids", () => {
  it("no reason or column note in the whole registry names a review thread, label, id (any run of nine digits) or a person's first name", () => {
    const strings: Array<[string, string]> = [];
    const walk = (path: string, v: unknown) => {
      if (typeof v === "string") strings.push([path, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x);
    };
    walk("registry", EXPORT_RESOURCE_REGISTRY);
    expect(strings.length).toBeGreaterThan(500);
    expect(strings.filter(([, s]) => REVIEW_MARKERS.test(s)).map(([p]) => p)).toEqual([]);
  });

  it("the machine-write receipts entry that was reworded still says what the table is, in the text the page and the export README print", () => {
    const entry = pendingResources().find((r) => r.resource === "block_write_receipts");
    expect(entry, "block_write_receipts stays a pending resource").toBeTruthy();
    const reason = entry!.disposition.reason;
    expect(reason.startsWith("Introduced by migration 0301 so a machine-identity write")).toBe(true);
    expect(reason).toContain("a RECEIPT for a transport");
    expect(reason).toContain("Kept for the life of the block (no pruning).");
    expect(entry!.disposition.ticket).toBe("TRUTH-01B");
    expect(entry!.disposition.tier).toBe(2);
  });

  it("the pending column notes are covered by the same rule", () => {
    expect(pendingColumns().filter((c) => c.note && REVIEW_MARKERS.test(c.note))).toEqual([]);
  });

  it("no internal ticket id (HON-n, TRUTH-) is in any string either consumer renders: registry reasons and notes, the README line and the manifest row", () => {
    const rendered: Array<[string, string]> = [];
    const walk = (path: string, v: unknown, key = "") => {
      // `ticket` is the one non-rendered field: the guards read it, the page and the archive never print it.
      if (key === "ticket") return;
      if (typeof v === "string") rendered.push([path, v]);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(`${path}[${i}]`, x));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${path}.${k}`, x, k);
    };
    walk("registry", EXPORT_RESOURCE_REGISTRY);
    expect(rendered.filter(([, s]) => TICKET_IDS.test(s)).map(([p]) => p)).toEqual([]);
    // The internal ticket is still there for the guards that need it.
    for (const e of pendingResources()) expect(e.disposition.ticket).toMatch(/^TRUTH-01[A-Z]$/);
  });

  it("the page and the export action never print the ticket, and carry no ticket id in code they render", () => {
    for (const f of ["app/(app)/settings/data/page.tsx", "app/(app)/settings/data/actions.ts"]) {
      const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const code = ts.createPrinter({ removeComments: true }).printFile(sf);
      expect(code.match(/TRUTH-|\bHON-\d/g) ?? [], f).toEqual([]);
      expect(/\.ticket\b/.test(code) && f.endsWith("page.tsx"), `${f} must not render the ticket`).toBe(false);
    }
    const actions = readFileSync("app/(app)/settings/data/actions.ts", "utf8");
    expect(actions).not.toMatch(/\$\{disposition\.ticket\}/);
    expect(actions).not.toMatch(/^\s*ticket: disposition\.ticket/m);
  });
});
