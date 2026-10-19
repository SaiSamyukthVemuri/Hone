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

describe("0231 portrait in the profile header: the Photos-tab trust boundary", () => {
  const helper = readFileSync(join(ROOT, "lib/images/client-portrait.ts"), "utf8");

  it("reads the row under RLS, scoped to studio + client + client-scope + unarchived", () => {
    expect(helper).toMatch(/import "server-only";/);
    expect(helper).toMatch(/const supabase = await createClient\(\);/);
    for (const f of [
      /\.eq\("id", input\.portraitImageId\)/,
      /\.eq\("studio_id", input\.studioId\)/,
      /\.eq\("client_id", input\.clientId\)/,
      /\.is\("session_id", null\)/,
      /\.is\("session_block_id", null\)/,
      /\.is\("deleted_at", null\)/,
    ]) {
      expect(helper).toMatch(f);
    }
  });

  it("validates the path BEFORE the admin client signs, with the shared 60 s TTL", () => {
    const validate = helper.indexOf("validateTreatmentImagePath({");
    const sign = helper.indexOf("createSignedUrl(");
    expect(validate).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(validate);
    expect(helper).toMatch(/if \(!ok\) return null;/);
    expect(helper).toMatch(/TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS/);
  });

  it("signs the bounded derivative only AFTER the original, from the validated path (Codex P2 4302682032)", () => {
    const original = helper.indexOf("storage.createSignedUrl(row.storage_path");
    const derive = helper.indexOf("buildTreatmentImageThumbPath(row.storage_path)");
    const thumb = helper.indexOf("storage.createSignedUrl(thumbPath");
    expect(original).toBeGreaterThan(helper.indexOf("validateTreatmentImagePath({"));
    expect(derive).toBeGreaterThan(original);
    expect(thumb).toBeGreaterThan(derive);
    expect(helper).toMatch(/return \{ url: data\.signedUrl, thumbUrl \};/);
  });

  it("the profile header renders the portrait only when one was signed", () => {
    const page = readFileSync(join(ROOT, "app/(app)/clients/[id]/page.tsx"), "utf8");
    // Inside the page's one parallel read wave, never a serial await of its own.
    expect(page).toMatch(/portraitUrl,\n\s*\] = await Promise\.all\(\[/);
    expect(page).not.toMatch(/await signedClientPortraitUrl/);
    expect(page).toMatch(/\{portraitUrl && \(/);
    // Keyed by the server URLs (fresh URLs remount it) and given the image id it
    // re-mints through.
    expect(page).toMatch(
      /<ClientPortrait key=\{`\$\{portraitUrl\.url\}:\$\{portraitUrl\.thumbUrl \?\? ""\}`\} clientId=\{client\.id\} imageId=\{client\.portrait_image_id!\} url=\{portraitUrl\.url\} thumbUrl=\{portraitUrl\.thumbUrl\} clientName=\{client\.name\} \/>/,
    );
    expect(page).not.toMatch(/src=\{portraitUrl\}/);
  });

  it("the header avatar loads the derivative first, demotes to the original, and re-mints an EXPIRED URL once per variant", () => {
    const comp = readFileSync(join(ROOT, "app/(app)/clients/[id]/ClientPortrait.tsx"), "utf8");
    expect(comp).toMatch(/^"use client";/);
    // The SHARED bounded recovery (#929 hook): timeout → one retry → terminal,
    // the hydration-window check, no retry loop. Pinned once, in
    // tests/app/clients/treatment-photo-thumbnail-recovery.test.ts.
    expect(comp).toMatch(/import \{ useGridPhotoRecovery \} from "@\/lib\/images\/use-grid-photo-recovery";/);
    expect(comp).toMatch(/useGridPhotoRecovery\(\{ previewUrl: url, thumbUrl, clientId, imageId \}\)/);
    // The re-mint is the hook's abortable GET, never a server action (Codex P1 4307807754).
    expect(comp).not.toMatch(/getTreatmentImageSignedUrlAction|from "\.\/images\/actions"/);
    expect(comp).toMatch(/ref=\{imgRef\}/);
    expect(comp).toMatch(/onError=\{onError\}/);
    expect(comp).toMatch(/if \(state\.stage === "broken" \|\| !state\.src\) return null;/);
    expect(comp).toMatch(/alt=\{`ID photo of \$\{clientName\}`\}/);
  });
});
