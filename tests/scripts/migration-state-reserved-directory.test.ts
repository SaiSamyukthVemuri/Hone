import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { getMigrationState, mergeReservedDeclarations, reservedFromDirectory } from "../../scripts/migration-state.mjs";

// Reserved numbers may be declared as one marker file per number. The same validation applies as for the array in the canonical record.

describe("reservedFromDirectory (pure)", () => {
  it("four-digit names are reservations, sorted; README.md is ignored", () => {
    expect(reservedFromDirectory(["0335", "README.md", "0333"])).toEqual({ declared: ["0333", "0335"], invalid: [] });
  });
  it("NEGATIVE CONTROL: any other name is reported, so a typo cannot silently reserve nothing", () => {
    const r = reservedFromDirectory(["333", "0334.txt", "notes"]);
    expect(r.declared).toEqual([]);
    expect(r.invalid.length).toBe(3);
  });
});

describe("mergeReservedDeclarations (pure)", () => {
  it("no array and no markers: nothing declared", () => {
    expect(mergeReservedDeclarations(undefined, [])).toEqual({ declared: undefined, invalid: [] });
  });
  it("union, sorted numerically as strings", () => {
    expect(mergeReservedDeclarations(["0301", "0330"], ["0333"])).toEqual({ declared: ["0301", "0330", "0333"], invalid: [] });
  });
  it("NEGATIVE CONTROL: a number in both places is invalid", () => {
    expect(mergeReservedDeclarations(["0333"], ["0333"]).invalid.join(" ")).toMatch(/both/);
  });
  it("a non-array record value is passed through so the validator reports it", () => {
    expect(mergeReservedDeclarations("0333", ["0334"]).declared).toBe("0333");
  });
});

function tree(opts: { files: string[]; markers: string[]; array?: unknown; hosted?: string }) {
  const root = mkdtempSync(join(tmpdir(), "mstate-"));
  const dir = join(root, "migrations");
  const markers = join(root, "reserved");
  mkdirSync(dir);
  mkdirSync(markers);
  for (const f of opts.files) writeFileSync(join(dir, `${f}_x.sql`), "-- x\n");
  for (const m of opts.markers) writeFileSync(join(markers, m), "");
  const canonicalFile = join(root, "state.json");
  const rec: Record<string, unknown> = { hosted_migration_max: opts.hosted ?? "0300", hosted_applied_at: null, hosted_note: "t" };
  if (opts.array !== undefined) rec.reserved_unallocated_above_hosted = opts.array;
  writeFileSync(canonicalFile, JSON.stringify(rec));
  return { dir, canonicalFile, reservedDir: markers };
}

describe("getMigrationState reads marker files through the same validation", () => {
  it("markers fill the hole between hosted and a pending migration: no undeclared hole, nothing invalid", () => {
    const s = getMigrationState(tree({ files: ["0300", "0303"], markers: ["0301", "0302"] }));
    expect(s.reserved_unallocated_above_hosted).toEqual(["0301", "0302"]);
    expect(s.invalid_reserved_declarations).toEqual([]);
  });
  it("NEGATIVE CONTROL (reservation beside its file): a marker whose migration file exists is invalid and reserves nothing", () => {
    const s = getMigrationState(tree({ files: ["0300", "0302", "0303"], markers: ["0301", "0302"] }));
    expect(s.invalid_reserved_declarations.join(" ")).toMatch(/0302 is declared reserved but has a repo file/);
    expect(s.reserved_unallocated_above_hosted).toEqual([]);
  });
  it("NEGATIVE CONTROL: a marker at or above the repo max or at or below the hosted max is invalid", () => {
    const s = getMigrationState(tree({ files: ["0300", "0303"], markers: ["0300", "0303", "0304"] }));
    expect(s.invalid_reserved_declarations.length).toBeGreaterThanOrEqual(3);
  });
  it("NEGATIVE CONTROL: a misnamed marker is invalid", () => {
    const s = getMigrationState(tree({ files: ["0300", "0303"], markers: ["0301", "oops"] }));
    expect(s.invalid_reserved_declarations.join(" ")).toMatch(/not a four-digit marker/);
    expect(s.reserved_unallocated_above_hosted).toEqual([]);
  });
  it("array and markers combine; the same number in both is invalid", () => {
    const ok = getMigrationState(tree({ files: ["0300", "0304"], markers: ["0302"], array: ["0301", "0303"] }));
    expect(ok.reserved_unallocated_above_hosted).toEqual(["0301", "0302", "0303"]);
    const dup = getMigrationState(tree({ files: ["0300", "0304"], markers: ["0301"], array: ["0301"] }));
    expect(dup.invalid_reserved_declarations.join(" ")).toMatch(/both/);
  });
  it("a caller that supplies its own canonicalFile does not read the repository's marker directory", () => {
    const t = tree({ files: ["0300", "0303"], markers: [] });
    const s = getMigrationState({ dir: t.dir, canonicalFile: t.canonicalFile });
    expect(s.reserved_unallocated_above_hosted).toEqual([]);
  });
});

describe("the canonical array is validated as written, with or without markers", () => {
  const bad = (array: unknown, markers: string[]) => getMigrationState(tree({ files: ["0300", "0305"], markers, array })).invalid_reserved_declarations.join(" ");
  it("NEGATIVE CONTROL: a duplicate in the array is still rejected with no markers", () => {
    expect(bad(["0301", "0301", "0302"], [])).not.toBe("");
  });
  it("NEGATIVE CONTROL: an out-of-order array is still rejected with no markers", () => {
    expect(bad(["0302", "0301"], [])).not.toBe("");
  });
  it("NEGATIVE CONTROL: a duplicate or out-of-order array is still rejected when markers exist beside it", () => {
    expect(bad(["0301", "0301"], ["0303"])).not.toBe("");
    expect(bad(["0302", "0301"], ["0303"])).not.toBe("");
  });
  it("a well-formed array merges with markers as before", () => {
    expect(mergeReservedDeclarations(["0301", "0302"], ["0303"])).toEqual({ declared: ["0301", "0302", "0303"], invalid: [] });
  });
});
