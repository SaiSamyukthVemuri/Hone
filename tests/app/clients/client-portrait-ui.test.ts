import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FETT photos (HON-43), 0231: the identification-portrait UI. Source contract;
// the database rules it relies on are proved in
// tests/db/client-identification-portrait.db.test.ts.

const ROOT = process.cwd();
const DIR = "app/(app)/clients/[id]/images";
const read = (f: string) => readFileSync(join(ROOT, DIR, f), "utf8");

describe("0231 portrait UI", () => {
  it("the control is offered ONLY on client-scoped photos, on the touch-floor primitive", () => {
    const src = read("PortraitControl.tsx");
    expect(src).toMatch(/if \(!clientScope\) return null;/);
    expect(src).toMatch(/import \{ Button \} from "@\/components\/ui\/button";/);
    expect(src).not.toMatch(/<button\b/);
    expect(src).toMatch(/Use as ID photo/);
    expect(src).toMatch(/Remove ID photo/);
    // Clearing sends null; setting sends this photo's id.
    expect(src).toMatch(/save\(null\)/);
    expect(src).toMatch(/save\(imageId\)/);
  });

  it("the page marks client scope from BOTH links being empty, and passes the pointer", () => {
    const page = read("page.tsx");
    expect(page).toMatch(/\.select\("id, name, portrait_image_id"\)/);
    expect(page).toMatch(/clientScope: m\.session_id == null && m\.session_block_id == null/);
    expect(page).toMatch(/portraitImageId=\{client\.portrait_image_id \?\? null\}/);
    const mgr = read("TreatmentImagesManager.tsx");
    expect(mgr).toMatch(
      /<PortraitControl clientId=\{clientId\} imageId=\{img\.id\} clientScope=\{img\.clientScope\} isPortrait=\{img\.id === portraitImageId\} \/>/,
    );
  });

  it("the action gates auth, calls the 0231 command, and keeps errors generic", () => {
    const actions = read("actions.ts");
    const fn = actions.slice(actions.indexOf("export async function setClientPortraitAction"));
    expect(fn).toMatch(/await getCurrentPractitionerWithStudio\(\);/);
    expect(fn).toMatch(/supabase\.rpc\("set_client_portrait", \{\s*p_client_id: input\.clientId,\s*p_image_id: input\.imageId,/);
    // Never forwards the database message (it could name another photo's state).
    expect(fn).not.toMatch(/error\.message/);
    expect(fn).toMatch(/"Could not update the ID photo\."/);
  });
});
