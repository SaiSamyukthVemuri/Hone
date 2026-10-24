import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";
import {
  ADDRESS_VISIBILITY_VALUES,
  ARRIVAL_INSTRUCTIONS_MAX_LENGTH,
} from "@/lib/booking/studio-location";

// ===========================================================================
// Migration 0251 — HON-50 studio arrival instructions and address
// visibility. SOURCE CONTRACT.
//
// Behaviour (defaults on existing and new rows, the CHECKs, the owner-only
// write through RLS, member read, no anon read, the 0204 admission guard left
// alone) is proved against a real database in
// tests/db/studio-arrival-address-visibility.db.test.ts. This file pins what
// that test cannot see: the file is the reviewed draft byte for byte, it is
// additive and creates no routine (so the 0129/0164 three-role revoke rule has
// nothing to act on), and its closed value set and length cap are the ones the
// application enforces.
// ===========================================================================

const VERSION = "0251";
const FILE = `${VERSION}_studio_arrival_and_address_visibility.sql`;
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");

describe(`${VERSION} is allocated correctly in the migration sequence`, () => {
  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("is the repository maximum, and nothing sits above it", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });
});

describe(`${VERSION} is the reviewed draft`, () => {
  it("is byte-identical to willow/HON-50-SCHEMA-DRAFT.sql", () => {
    expect(createHash("sha256").update(SQL, "utf8").digest("hex")).toBe(
      "2b628ba6e3428a24567a06c39f975ac78be4a4e8954471795d7726c95f147922",
    );
  });
});

describe(`${VERSION} leaves every applied migration it relies on untouched`, () => {
  // The studios table and its RLS policies (0001), and the admission guard
  // that also sits on studios (0204/0205).
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0001_init.sql", "34994656f9f1062d9c220492971d3adcce9b2437e096c353d9dd6ba33aeb2b2a"],
    ["0204_new_client_admission_mode.sql", "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219"],
    ["0205_new_studio_admission_default.sql", "22c02160886c8c0bb3d98a086d48db08daea5de86114448c995d8af3322c2e17"],
  ];
  it.each(APPLIED)("%s is unchanged", (file, sha) => {
    const body = readFileSync(path.join(process.cwd(), "supabase/migrations", file), "utf8");
    expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(sha);
  });
});

describe(`${VERSION} is one transaction that arms its own lock timeout`, () => {
  it("opens with begin; and ends with commit;", () => {
    expect(CODE.match(/^begin;\s*$/gm)).toHaveLength(1);
    expect(CODE.match(/^commit;\s*$/gm)).toHaveLength(1);
    expect(CODE.trim().endsWith("commit;")).toBe(true);
  });

  it("sets lock_timeout INSIDE the transaction (a bare SET LOCAL never arms: 25P01)", () => {
    const begin = CODE.indexOf("begin;");
    const timeout = CODE.indexOf("set local lock_timeout");
    expect(timeout).toBeGreaterThan(begin);
  });
});

describe(`${VERSION} is additive and creates no routine`, () => {
  it("creates no function, procedure, trigger, view or policy, and grants nothing", () => {
    expect(CODE).not.toMatch(/create\s+(or\s+replace\s+)?(function|procedure|trigger|view|policy)\b/i);
    expect(CODE).not.toMatch(/\bgrant\b/i);
    expect(CODE).not.toMatch(/security\s+definer/i);
  });

  it("drops, renames, rewrites and deletes nothing", () => {
    expect(CODE).not.toMatch(/\bdrop\s+(table|column|constraint|policy|trigger|function)\b/i);
    expect(CODE).not.toMatch(/\brename\b/i);
    expect(CODE).not.toMatch(/alter\s+column/i);
    expect(CODE).not.toMatch(/^\s*(update|delete|insert)\b/im);
  });

  it("adds exactly the two studios columns, idempotently", () => {
    const adds = [...CODE.matchAll(/add column if not exists (\w+)/g)].map((m) => m[1]);
    expect(adds).toEqual(["arrival_instructions", "address_visibility"]);
    expect(CODE.match(/alter table public\.studios/g)?.length).toBeGreaterThanOrEqual(2);
    expect(CODE).not.toMatch(/alter table (?!public\.studios)/);
  });
});

describe(`${VERSION} matches what the application enforces`, () => {
  it("address_visibility defaults to 'both' (today's behaviour) and is NOT NULL", () => {
    expect(CODE).toMatch(/add column if not exists address_visibility text not null default 'both';/);
  });

  it("the CHECK is the application's closed set, in order", () => {
    const set = ADDRESS_VISIBILITY_VALUES.map((v) => `'${v}'`).join(", ");
    expect(CODE).toContain(`check (address_visibility in (${set}))`);
  });

  it("arrival_instructions is nullable, refuses blank, and caps at the application's limit", () => {
    expect(CODE).toMatch(/add column if not exists arrival_instructions text;/);
    expect(CODE).toContain("btrim(arrival_instructions) <> ''");
    expect(CODE).toContain(`char_length(arrival_instructions) <= ${ARRIVAL_INSTRUCTIONS_MAX_LENGTH}`);
  });

  it("each constraint is added only when absent, by name", () => {
    for (const name of ["studios_arrival_instructions_check", "studios_address_visibility_check"]) {
      expect(CODE).toContain(`conname = '${name}'`);
      expect(CODE).toContain(`add constraint ${name}`);
    }
  });
});
