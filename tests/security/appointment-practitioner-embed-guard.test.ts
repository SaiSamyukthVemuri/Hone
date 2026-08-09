import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync, statSync } from "node:fs";

// ===========================================================================
// PostgREST embed disambiguation guard — added by B5 / migration 0174.
// ===========================================================================
//
// WHAT WENT WRONG, so this guard's existence is not a mystery later.
//
// Before 0174, `public.appointments` had exactly ONE foreign key to
// `public.practitioners` (`appointments_practitioner_same_studio_fk`), so
// PostgREST could resolve a bare embed:
//
//     .from("appointments").select("*, practitioner:practitioners(id, ...)")
//
// 0174 added THREE more — created_by, cancelled_by and the outside-hours
// authoriser. PostgREST then refuses to guess and fails the whole request:
//
//     PGRST201: Could not embed because more than one relationship
//               was found for 'appointments' and 'practitioners'
//
// That is a RUNTIME 500 on the dashboard and the calendar detail page, and it
// is invisible to `npm run test:db`: that lane talks to Postgres directly
// through `pg`, so it never exercises PostgREST's relationship resolution. It
// was caught only by the browser e2e lane, several minutes into a full-matrix
// CI run, as a cascade of timeouts rather than as a clear error.
//
// The fix is to name the constraint in every such embed:
//
//     practitioner:practitioners!appointments_practitioner_same_studio_fk(...)
//
// This guard makes the next occurrence a fast unit-test failure instead. It
// matters beyond B5: B6, B7 and B8 all touch this table, and ANY future
// migration that adds a second FK between two tables reintroduces the hazard
// for whatever embed already existed.

const ROOTS = ["app", "lib", "components"] as const;
const REPO = join(__dirname, "..", "..");

/** The FK that carries the ASSIGNED practitioner — the one an embed means. */
const ASSIGNMENT_FK = "appointments_practitioner_same_studio_fk";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const FILES = ROOTS.flatMap((r) => walk(join(REPO, r)));

/**
 * Every `.select(...)` string that belongs to a `.from("appointments")` query.
 * The window is deliberately generous — the select is sometimes assembled from
 * a const a few lines above the `.from` — and the const form is picked up by
 * the whole-file scan below, so a query split across helpers cannot hide.
 */
type Embed = { file: string; select: string };

function appointmentSelects(): Embed[] {
  const found: Embed[] = [];
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    if (!src.includes('from("appointments")') && !src.includes("from('appointments')")) {
      continue;
    }
    // Any select-ish string literal in a file that queries appointments. This
    // over-collects rather than under-collects on purpose: a false positive
    // costs one FK annotation, a false negative costs a production 500.
    for (const m of src.matchAll(/["'`]([^"'`]*practitioners[^"'`]*)["'`]/g)) {
      const s = m[1];
      if (!/practitioners\s*[(!]/.test(s)) continue;
      found.push({ file: file.slice(REPO.length + 1), select: s });
    }
  }
  return found;
}

describe("PostgREST: appointments -> practitioners embeds must name their FK", () => {
  const embeds = appointmentSelects();

  it("finds the embeds at all (the guard is not vacuous)", () => {
    // Without this, deleting every embed — or breaking the scanner — would
    // leave the suite green while proving nothing.
    expect(embeds.length).toBeGreaterThanOrEqual(8);
  });

  it("every one names appointments_practitioner_same_studio_fk", () => {
    const offenders = embeds.filter(
      (e) => !e.select.includes(`practitioners!${ASSIGNMENT_FK}`),
    );
    expect(
      offenders.map((o) => `${o.file}: ${o.select.slice(0, 120)}`),
      "a bare `practitioners(...)` embed on an appointments query raises PGRST201 " +
        "since 0174 added three attribution FKs. Name the constraint: " +
        `practitioners!${ASSIGNMENT_FK}(...)`,
    ).toEqual([]);
  });

  it("the named FK is the ASSIGNMENT one, not an attribution column", () => {
    // Embedding through created_by/cancelled_by would compile and return a
    // row — the wrong practitioner. That is worse than an error, because the
    // UI would silently show whoever booked the appointment as the person
    // performing it.
    for (const e of embeds) {
      for (const wrong of [
        "appointments_created_by_practitioner_same_studio_fk",
        "appointments_cancelled_by_practitioner_same_studio_fk",
        "appointments_outside_availability_authorizer_same_studio_fk",
      ]) {
        expect(
          e.select.includes(wrong),
          `${e.file} embeds the practitioner through ${wrong}, which is the ` +
            "ATTRIBUTION FK, not the assigned practitioner",
        ).toBe(false);
      }
    }
  });
});
