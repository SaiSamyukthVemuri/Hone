import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

// PR #271. Security source-grep pins for secure treatment image storage:
// private bucket + signed-URL-only access, server-side service-role gated by a
// studio-ownership re-check, NO public URL, NO public/client exposure, NO
// OCR/AI, NO Jane assets, soft-delete only, exactly one paymentIntents.create.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}
function grep(pattern: string, paths: string): string {
  return execSync(
    `grep -rln '${pattern}' ${paths} --include='*.ts' --include='*.tsx' 2>/dev/null || true`,
    { cwd: process.cwd() },
  )
    .toString()
    .trim();
}

const ACTIONS = read("app/(app)/clients/[id]/images/actions.ts");
const LIB = read("lib/images/treatment-images.ts");
const MANAGER = read("app/(app)/clients/[id]/images/TreatmentImagesManager.tsx");
const PAGE = read("app/(app)/clients/[id]/images/page.tsx");
const MIGRATION = read("supabase/migrations/0092_treatment_images.sql");

describe("private bucket + signed-URL-only (no public URLs)", () => {
  it("the bucket is private and the migration never creates a public URL", () => {
    expect(MIGRATION).toMatch(/'treatment-images',\s*'treatment-images',\s*false/);
    expect(MIGRATION).not.toMatch(/getPublicUrl/);
  });
  it("viewing mints a signed URL; getPublicUrl is never used anywhere", () => {
    expect(ACTIONS).toMatch(/createSignedUrl/);
    expect(grep("getPublicUrl", "app lib components")).toBe("");
  });
});

describe("server-side, studio-ownership-gated access", () => {
  it("uses service-role for storage and the RLS client for metadata", () => {
    expect(ACTIONS).toMatch(/createAdminClient/);
    expect(ACTIONS).toMatch(/createClient/);
  });
  it("re-checks the row's studio before signing (never signs a client path)", () => {
    expect(ACTIONS).toMatch(/\.eq\("studio_id", studio\.id\)/);
    // the signed-url action signs the bucket/path FROM the verified row it
    // loaded by id + studio — never a client-supplied path.
    expect(ACTIONS).toMatch(/getTreatmentImageSignedUrlAction/);
    expect(ACTIONS).toMatch(/\.from\(row\.storage_bucket\)/);
    expect(ACTIONS).toMatch(/createSignedUrl\(row\.storage_path/);
  });
  it("the client manager never imports the service-role client", () => {
    expect(MANAGER).not.toMatch(/admin-server|createAdminClient|SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe("no public/client-facing exposure", () => {
  it("no public/token route imports the image feature", () => {
    const offenders = grep(
      "images/actions\\|treatment-images\\|TreatmentImagesManager",
      "app/book app/intake app/portal app/cancel app/reschedule app/manage",
    );
    expect(offenders).toBe("");
  });
  it("the practitioner manager carries the private-storage wording + MIME allowlist", () => {
    expect(MANAGER).toMatch(/Stored privately/);
    expect(MANAGER).toMatch(/Visible to practitioners in this studio/);
    expect(MANAGER).toMatch(/accept="image\/jpeg,image\/png,image\/webp"/);
    expect(PAGE).toMatch(/Stored privately/);
  });
  it("the practitioner nav links to the images route (PR #272: in the tab bar)", () => {
    // PR #272 moved the link out of the Health tab into the client tab bar
    // (a "Treatment Photos" route link), so it is no longer buried.
    const tabBar = read("components/profile-tab-bar.tsx");
    expect(tabBar).toMatch(/Treatment Photos/);
    expect(tabBar).toMatch(/\$\{pathname\}\/images/);
  });
});

describe("no OCR/AI, no Jane assets, no payment change", () => {
  for (const [label, src] of [
    ["actions", ACTIONS],
    ["lib", LIB],
    ["manager", MANAGER],
    ["page", PAGE],
  ] as const) {
    it(`${label} has no OCR/AI / Jane / payment-charge code`, () => {
      expect(src).not.toMatch(/tesseract|createWorker|\bOCR\b|openai|anthropic|generativeai/i);
      expect(src).not.toMatch(/jane\.app|\/thumbs\//i);
      expect(src).not.toMatch(/paymentIntents\.create|charges\.create/);
    });
  }
});
