import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion } from "./helpers/migration-state";
import { TREATMENT_AREA_IDS } from "@/lib/waitlist/treatment-area-catalog";
import { AVAILABILITY_PREFERENCES } from "@/lib/waitlist/join-profile";
import {
  SMS_CONSENT_SOURCES,
  SMS_OPT_OUT_SOURCES,
  SMS_OPERATIONAL_CONSENT_TEXT_VERSION,
} from "@/lib/waitlist/prospect-sms-consent";

// 0202 — DURABLE PROSPECT PROFILE AND SMS CONSENT AUTHORITY.
//
// The migration is applied and frozen; behaviour is proved against a real
// database in tests/db/waitlist-profile-and-sms-consent-authority.db.test.ts.
// This file pins the live TypeScript vocabularies to the values the SQL restates.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0202";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

describe("vocabularies are pinned against their TypeScript source", () => {
  it("the treatment-area catalog matches TREATMENT_AREA_IDS exactly, in order", () => {
    // The SQL restates the catalog so the database re-checks independently of
    // the application. Two copies of one list is a drift risk; this is what
    // makes it fail instead.
    const block = CODE.slice(CODE.indexOf("'upper_lip'"));
    const ids = (block.match(/'[a-z_]+'/g) ?? [])
      .slice(0, TREATMENT_AREA_IDS.length)
      .map((s) => s.replace(/'/g, ""));
    expect(ids).toEqual([...TREATMENT_AREA_IDS]);
  });

  it("the consent-source check equals SMS_CONSENT_SOURCES", () => {
    for (const s of SMS_CONSENT_SOURCES) expect(CODE).toContain(`'${s}'`);
  });

  it("the opt-out-source check equals SMS_OPT_OUT_SOURCES", () => {
    for (const s of SMS_OPT_OUT_SOURCES) expect(CODE).toContain(`'${s}'`);
  });

  it("the consent text version is pinned to the shipped constant", () => {
    expect(CODE).toContain(`'${SMS_OPERATIONAL_CONSENT_TEXT_VERSION}'`);
  });

  it("the availability vocabulary equals AVAILABILITY_PREFERENCES", () => {
    for (const p of AVAILABILITY_PREFERENCES) expect(CODE).toContain(`'${p}'`);
  });
});
