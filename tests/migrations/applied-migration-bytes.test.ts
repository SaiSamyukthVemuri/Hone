import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// An applied migration is frozen (CLAUDE.md §5). These are the reviewed
// byte-for-byte SHA-256 pins that used to live in the per-migration text tests;
// they moved here verbatim when those tests were removed, so each file keeps
// its freeze guard. `supabase/schema-snapshot.json` is NOT that guard: it is
// regenerated whenever a migration is edited.
//
// A pin goes red on ANY edit to the file. Never update a pin to make it pass:
// write a new migration instead.
const PINS: Record<string, string> = {
  "0126_client_clinical_notes.sql":
    "6cd91229e65f8d1e71cf40a9ca644bf483b61eedc44acba29ff6c3b6ad0c74ec",
  "0129_atomic_session_block_area_writes.sql":
    "5ae4a4ea6037f49ed8f6bedb0291e950f1f94f9f99e9482b5077687b3f0c2334",
};

const DIR = path.resolve(__dirname, "../../supabase/migrations");

describe("applied migrations are byte-for-byte unchanged", () => {
  it.each(Object.entries(PINS))("%s", (file, sha) => {
    expect(createHash("sha256").update(readFileSync(path.join(DIR, file))).digest("hex")).toBe(sha);
  });
});
