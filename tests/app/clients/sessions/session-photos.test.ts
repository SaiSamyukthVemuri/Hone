import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// FETT photos (HON-43): a visit's photos on that visit's chart page.
// Source contract: the Photos tab's trust boundary, inside the page's single
// parallel wave, and read-only.

const ROOT = process.cwd();
const DIR = "app/(app)/clients/[id]/sessions/[sessionId]";
const read = (f: string) => readFileSync(join(ROOT, DIR, f), "utf8");

describe("session photos: the Photos tab's trust boundary", () => {
  const helper = read("session-photos.ts");

  it("reads under RLS, scoped to studio + client + this session, unarchived", () => {
    expect(helper).toMatch(/import "server-only";/);
    expect(helper).toMatch(/const supabase = await createClient\(\);/);
    for (const f of [
      /\.eq\("studio_id", input\.studioId\)/,
      /\.eq\("client_id", input\.clientId\)/,
      /\.eq\("session_id", input\.sessionId\)/,
      /\.is\("deleted_at", null\)/,
    ]) {
      expect(helper).toMatch(f);
    }
  });

  it("validates each path BEFORE signing, drops failures, uses the shared 60 s TTL", () => {
    const validate = helper.indexOf("validateTreatmentImagePath({");
    const sign = helper.indexOf("createSignedUrl(");
    expect(validate).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(validate);
    expect(helper).toMatch(/if \(!ok\) return null;/);
    expect(helper).toMatch(/TREATMENT_IMAGE_SIGNED_URL_TTL_SECONDS/);
    expect(helper).toMatch(/\.filter\(\(p\): p is SessionPhoto => p !== null\)/);
  });

  it("labels areas exactly as the Photos tab does, including 0128 structured areas", () => {
    expect(helper).toMatch(/getSessionBlockAreasByBlockIds\(/);
    expect(helper).toMatch(/structured_areas:/);
    expect(helper).toMatch(/treatmentPhotoAreaLabel\(r\.session_block_id, block\)/);
  });
});

describe("session photos on the chart page", () => {
  const page = read("page.tsx");
  const section = read("SessionPhotos.tsx");

  it("the read is INSIDE the page's one parallel wave, never its own serial await", () => {
    expect(page).toMatch(/const \[\n\s*sessionPhotos,\n\s*lastEntry,/);
    expect(page).toMatch(/timed\("session-chart\.photos", \(\) =>\n\s*signedSessionPhotos\(/);
    expect(page).not.toMatch(/await signedSessionPhotos/);
  });

  it("is read-only: no server action, no form, no click handler, links to the Photos tab", () => {
    expect(section).not.toMatch(/use server|<form|onClick|from "\.\/actions"/);
    // Read-only still: the ONLY import from the Photos actions is the READ-only
    // signer the expired-URL re-mint uses (#913's bounded recovery), never an
    // upload, note or archive write.
    expect(section).toMatch(/import \{ getTreatmentImageSignedUrlAction \} from "\.\.\/\.\.\/images\/actions";/);
    expect(section).not.toMatch(/uploadTreatmentImageAction|archiveTreatmentImageAction|updateTreatmentImageNoteAction|setClientPortraitAction/);
    expect(section).toMatch(/href=\{`\/clients\/\$\{clientId\}\/images`\}/);
    expect(section).toMatch(/if \(photos\.length === 0\) return null;/);
    expect(page).toMatch(/<SessionPhotos clientId=\{id\} photos=\{sessionPhotos\} \/>/);
  });

  it("the link back to Photos is on the 44px touch floor", () => {
    expect(section).toMatch(/className="inline-flex min-h-\[44px\] items-center/);
  });
});

describe("session photos: Codex P1 4301862700 / P2 4301862702", () => {
  const helper = read("session-photos.ts");
  const section = read("SessionPhotos.tsx");

  it("loads EAGERLY: no lazy request that could outlive the 60 s URL", () => {
    expect(section).not.toMatch(/loading="lazy"/);
    // An original that still fails shows a reload note, never a broken image.
    expect(section).toMatch(/Photo unavailable — reload to view/);
  });

  it("signs the grid derivative only AFTER the original, and falls back to it", () => {
    const original = helper.indexOf("createSignedUrl(r.storage_path");
    const derivative = helper.indexOf("createSignedUrl(thumbPath");
    expect(original).toBeGreaterThan(-1);
    expect(derivative).toBeGreaterThan(original);
    expect(helper).toMatch(/if \(!data\?\.signedUrl\) return null;/);
    expect(helper).toMatch(/buildTreatmentImageThumbPath\(r\.storage_path\)/);
    // Grid uses the derivative; a derivative that will not load demotes to the
    // original; only the original failing marks the cell unavailable.
    // Since #913 this is the SAME bounded machine as the Photos grid:
    // derivative, then original, re-minting an expired URL once per variant.
    expect(section).toMatch(/initialGridPhoto\(\{ previewUrl: p\.url, thumbUrl: p\.thumbUrl \}\)/);
    expect(section).toMatch(/getTreatmentImageSignedUrlAction\(\{ imageId: p\.id, variant \}\)/);
    expect(section).toMatch(/if \(el\.complete && el\.naturalWidth === 0\) \{\s*handleError\(\);\s*return;\s*\}/);
    expect(section).toMatch(/el\.addEventListener\("error", onNativeError\);/);
    expect(section).toMatch(/return \(\) => el\.removeEventListener\("error", onNativeError\);/);
    expect(section).toMatch(/state\.stage === "broken" \|\| !state\.src/);
    expect(section).not.toMatch(/loading="lazy"/);
  });
});

describe("0232: visit photos are grouped by capture stage in STACKED sections", () => {
  const helper = read("session-photos.ts");
  const section = read("SessionPhotos.tsx");

  it("the read carries capture_stage, normalised to before | after | null", () => {
    expect(helper).toMatch(/practitioner_note, capture_stage, session_blocks/);
    expect(helper).toMatch(/r\.capture_stage === "before" \|\| r\.capture_stage === "after" \? r\.capture_stage : null/);
  });

  it("groups Before, After, Other in that order, hides empty groups, and keeps one grid when nothing is labelled", () => {
    expect(section).toMatch(/\{ key: "before", heading: "Before" \},\s*\{ key: "after", heading: "After" \},\s*\{ key: null, heading: "Other" \},/);
    expect(section).toMatch(/if \(inGroup\.length === 0\) return null;/);
    expect(section).toMatch(/photos\.some\(\(p\) => p\.captureStage\) \?/);
    // Stacked: each group is a column-flex block with its own grid.
    expect(section).toMatch(/<div key=\{g\.heading\} className="flex flex-col gap-2"/);
  });
});
