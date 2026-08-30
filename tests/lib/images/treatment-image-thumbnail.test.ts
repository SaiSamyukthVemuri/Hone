import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import sharp from "sharp";

import { sanitizeTreatmentImage } from "@/lib/images/treatment-image-sanitize";
import {
  buildTreatmentImagePath,
  buildTreatmentImageThumbPath,
  sanitizeFilename,
  selectGridImageSource,
  validateTreatmentImagePath,
  TREATMENT_IMAGE_THUMB_MAX_EDGE,
  TREATMENT_IMAGES_BUCKET,
} from "@/lib/images/treatment-images";

// PERF-IMG-03. The grid derivative.
//
// WHAT THIS SLICE IS: one bounded WebP thumbnail per NEW upload, used by the
// photo grid only. The stored original is never resized, re-formatted, replaced
// or repointed, and the modal — the surface where a practitioner actually
// inspects a photo — keeps signing the original.
//
// THE GUARANTEE THESE TESTS EXIST TO PIN: a derivative that is missing, that
// cannot be produced, or that fails to load must cost the practitioner NOTHING
// but bytes. It must never turn a stored clinical image into "Image not
// available". Several assertions below are therefore about the ORIGINAL
// surviving, not about the thumbnail working.
//
// Fixtures are built with sharp at test time (repo convention: no committed
// binaries). No production object is read and no storage call is made.

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const IMAGE_ID = "33333333-3333-4333-8333-333333333333";

function canvas(width: number, height: number) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 180, g: 90, b: 90 },
    },
  });
}

// A photo-like fixture: smooth gradients compress the way a real photograph
// does, so "the derivative is smaller" is a meaningful assertion rather than an
// artefact of a flat-colour image.
async function photoLike(width: number, height: number): Promise<Buffer> {
  const noise = Buffer.alloc(width * height * 3);
  for (let i = 0; i < noise.length; i += 3) {
    const px = i / 3;
    noise[i] = (px * 7) % 256;
    noise[i + 1] = (px * 13) % 256;
    noise[i + 2] = (px * 29) % 256;
  }
  return sharp(noise, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92 })
    .toBuffer();
}

describe("the derivative is bounded, and bounded by the MEASURED display box", () => {
  it("caps the longest edge at 1024 and keeps the aspect ratio", async () => {
    const bytes = await photoLike(2400, 1600);
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/jpeg",
    });
    expect(r.ok).toBe(true);
    if (!r.ok || !r.thumbBytes) throw new Error("expected a derivative");

    const meta = await sharp(r.thumbBytes).metadata();
    expect(meta.format).toBe("webp");
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(
      TREATMENT_IMAGE_THUMB_MAX_EDGE,
    );
    // 2400x1600 is 3:2; the derivative must still be 3:2.
    expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(2400 / 1600, 2);
  });

  it("bounds a PORTRAIT original by its HEIGHT, not its width", async () => {
    const bytes = await photoLike(1200, 2400);
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/jpeg",
    });
    if (!r.ok || !r.thumbBytes) throw new Error("expected a derivative");
    const meta = await sharp(r.thumbBytes).metadata();
    expect(meta.height).toBe(TREATMENT_IMAGE_THUMB_MAX_EDGE);
    expect(meta.width).toBeLessThan(TREATMENT_IMAGE_THUMB_MAX_EDGE);
  });

  it("is materially smaller than the original it stands in for", async () => {
    const bytes = await photoLike(2400, 1600);
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/jpeg",
    });
    if (!r.ok || !r.thumbBytes) throw new Error("expected a derivative");
    expect(r.thumbBytes.length).toBeLessThan(r.bytes.length);
  });
});

describe("the ORIGINAL is untouched by the derivative's existence", () => {
  it("keeps the original's format and full dimensions", async () => {
    const bytes = await photoLike(2400, 1600);
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/jpeg",
    });
    if (!r.ok) throw new Error("expected ok");
    const meta = await sharp(r.bytes).metadata();
    expect(r.contentType).toBe("image/jpeg");
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(2400);
    expect(meta.height).toBe(1600);
  });

  it("NEVER upscales: a small original yields no derivative rather than a bigger one", async () => {
    // 8x8 is far below the grid box. A WebP re-encode of it can easily exceed
    // the JPEG original, and shipping that would make the grid slower.
    const bytes = await canvas(8, 8).jpeg().toBuffer();
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/jpeg",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    // Either no derivative at all, or one that is genuinely smaller AND not
    // enlarged past the source.
    if (r.thumbBytes) {
      expect(r.thumbBytes.length).toBeLessThan(r.bytes.length);
      const meta = await sharp(r.thumbBytes).metadata();
      expect(meta.width).toBeLessThanOrEqual(8);
      expect(meta.height).toBeLessThanOrEqual(8);
    }
  });

  it("a missing derivative is NOT an error: ok stays true", async () => {
    const bytes = await canvas(8, 8).png().toBuffer();
    const r = await sanitizeTreatmentImage({
      bytes,
      declaredContentType: "image/png",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("expected ok");
    expect(r.bytes.length).toBeGreaterThan(0);
    // thumbBytes may be null. That is a legal, non-error outcome.
    expect(r.thumbBytes === null || Buffer.isBuffer(r.thumbBytes)).toBe(true);
  });
});

describe("the derivative inherits the sanitiser's guarantees, never re-implements them", () => {
  it("carries no EXIF/GPS — a second encode is a second chance to leak", async () => {
    const withExif = await sharp(await photoLike(1600, 1200))
      .withMetadata({
        exif: {
          IFD0: { Copyright: "synthetic-fixture", Software: "vitest" },
        },
      })
      .jpeg({ quality: 92 })
      .toBuffer();
    // The fixture really does carry metadata, else this proves nothing.
    expect((await sharp(withExif).metadata()).exif).toBeTruthy();

    const r = await sanitizeTreatmentImage({
      bytes: withExif,
      declaredContentType: "image/jpeg",
    });
    if (!r.ok || !r.thumbBytes) throw new Error("expected a derivative");
    expect((await sharp(r.bytes).metadata()).exif).toBeUndefined();
    expect((await sharp(r.thumbBytes).metadata()).exif).toBeUndefined();
  });

  it("inherits the orientation bake: EXIF-rotated input yields upright pixels in BOTH outputs", async () => {
    // orientation 6 = rotate 90deg CW on display. After .rotate() the pixels are
    // upright and the tag is gone, so a 1200x800 source presents as 800x1200.
    const rotated = await sharp(await photoLike(1200, 800))
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 92 })
      .toBuffer();

    const r = await sanitizeTreatmentImage({
      bytes: rotated,
      declaredContentType: "image/jpeg",
    });
    if (!r.ok || !r.thumbBytes) throw new Error("expected a derivative");

    const orig = await sharp(r.bytes).metadata();
    expect(orig.width).toBe(800);
    expect(orig.height).toBe(1200);

    // The derivative must agree with the original about which way is up.
    const thumb = await sharp(r.thumbBytes).metadata();
    expect((thumb.height ?? 0) > (thumb.width ?? 0)).toBe(true);
  });
});

describe("the derived key is authorized by derivation, not by a new rule", () => {
  const original = buildTreatmentImagePath({
    studioId: STUDIO,
    clientId: CLIENT,
    id: IMAGE_ID,
    contentType: "image/jpeg",
  });

  it("derives a sibling key under the same studio/client prefix", () => {
    const thumb = buildTreatmentImageThumbPath(original);
    expect(thumb).toBe(`${STUDIO}/${CLIENT}/${IMAGE_ID}.thumb.webp`);
  });

  it("the derived key passes the SAME signer validator the original passes", () => {
    const thumb = buildTreatmentImageThumbPath(original);
    expect(thumb).not.toBeNull();
    expect(
      validateTreatmentImagePath({
        expectedStudioId: STUDIO,
        rowStudioId: STUDIO,
        rowClientId: CLIENT,
        storageBucket: TREATMENT_IMAGES_BUCKET,
        storagePath: thumb as string,
      }),
    ).toEqual({ ok: true });
  });

  it("the derived FILENAME satisfies the 0093 storage_path CHECK, read from the migration", () => {
    const sql = readFileSync(
      "supabase/migrations/0093_harden_treatment_image_storage.sql",
      "utf8",
    );
    // The constraint's own filename alternation, lifted from the migration text
    // rather than restated here, so a future tightening of the CHECK fails this
    // test instead of silently diverging from it.
    const m = sql.match(/\/\[A-Za-z0-9\._-\]\+\\\.\((jpg\|jpeg\|png\|webp)\)\$/);
    expect(m, "0093 filename pattern not found — the CHECK shape changed").toBeTruthy();

    const thumb = buildTreatmentImageThumbPath(original) as string;
    const filename = thumb.split("/")[2];
    expect(new RegExp(`^[A-Za-z0-9._-]+\\.(${m![1]})$`).test(filename)).toBe(true);
  });

  it("NEGATIVE CONTROL: a malformed or hostile original yields NO key at all", () => {
    // Each of these would be rejected by validateTreatmentImagePath. Derivation
    // must not manufacture a well-formed key from any of them — validate first,
    // derive second, and derive nothing from something that failed.
    for (const bad of [
      "",
      "only/two",
      `${STUDIO}/${CLIENT}/../../etc/passwd`,
      `${STUDIO}/${CLIENT}/no-extension`,
      `${STUDIO}/${CLIENT}/evil.svg`,
      `${STUDIO}/${CLIENT}/has space.jpg`,
      `${STUDIO}/${CLIENT}/a/b.jpg`,
      `${STUDIO}/${CLIENT}/.jpg`,
    ]) {
      expect(buildTreatmentImageThumbPath(bad), bad).toBeNull();
    }
  });

  it("a derived key is never mistaken for a NEW original: the id segment is preserved", () => {
    const thumb = buildTreatmentImageThumbPath(original) as string;
    // Same three segments, same studio, same client — only the filename differs,
    // so the object cannot land under another tenant's prefix.
    const [s, c] = thumb.split("/");
    expect(s).toBe(STUDIO);
    expect(c).toBe(CLIENT);
  });
});

describe("FAIL-OPEN: a thumbnail problem must never hide a clinical image", () => {
  const ORIG = "https://signed/original";
  const THUMB = "https://signed/thumb";

  it("prefers the derivative when one is available", () => {
    const r = selectGridImageSource({
      previewUrl: ORIG,
      thumbUrl: THUMB,
      thumbFailed: false,
      broken: false,
    });
    expect(r.src).toBe(THUMB);
    expect(r.usingThumb).toBe(true);
    expect(r.showPreview).toBe(true);
  });

  it("renders the ORIGINAL when there is no derivative (every pre-existing row)", () => {
    const r = selectGridImageSource({
      previewUrl: ORIG,
      thumbUrl: null,
      thumbFailed: false,
      broken: false,
    });
    expect(r.src).toBe(ORIG);
    expect(r.usingThumb).toBe(false);
    expect(r.showPreview).toBe(true);
  });

  it("DEMOTES to the original when the derivative fails to load — never hides it", () => {
    const r = selectGridImageSource({
      previewUrl: ORIG,
      thumbUrl: THUMB,
      thumbFailed: true,
      broken: false,
    });
    expect(r.src).toBe(ORIG);
    expect(r.usingThumb).toBe(false);
    // The decisive assertion of this slice.
    expect(r.showPreview).toBe(true);
  });

  it("availability depends on the ORIGINAL alone: a present thumb cannot rescue a broken original", () => {
    const r = selectGridImageSource({
      previewUrl: ORIG,
      thumbUrl: THUMB,
      thumbFailed: false,
      broken: true,
    });
    expect(r.showPreview).toBe(false);
  });

  it("no original signed means unavailable, exactly as before this change", () => {
    const r = selectGridImageSource({
      previewUrl: null,
      thumbUrl: THUMB,
      thumbFailed: false,
      broken: false,
    });
    expect(r.showPreview).toBe(false);
  });
});

describe("TENANCY: a derivative cannot become a way to reach another studio", () => {
  const OTHER_STUDIO = "44444444-4444-4444-8444-444444444444";
  const OTHER_CLIENT = "55555555-5555-4555-8555-555555555555";

  const foreign = buildTreatmentImagePath({
    studioId: OTHER_STUDIO,
    clientId: OTHER_CLIENT,
    id: IMAGE_ID,
    contentType: "image/jpeg",
  });

  it("UNAUTHORIZED STAYS UNAUTHORIZED: a foreign original is refused, and so is its derivative", () => {
    // Derivation is a string operation and is NOT authorization — it will
    // happily produce a well-formed key for a foreign path. What must hold is
    // that the SIGNER's validator refuses both, so neither is ever signed for
    // the wrong caller. This asserts the composition, which is the property the
    // page actually relies on.
    const asCaller = {
      expectedStudioId: STUDIO,
      rowStudioId: OTHER_STUDIO,
      rowClientId: OTHER_CLIENT,
      storageBucket: TREATMENT_IMAGES_BUCKET,
    };
    expect(
      validateTreatmentImagePath({ ...asCaller, storagePath: foreign }).ok,
    ).toBe(false);

    const foreignThumb = buildTreatmentImageThumbPath(foreign) as string;
    expect(foreignThumb).not.toBeNull();
    expect(
      validateTreatmentImagePath({ ...asCaller, storagePath: foreignThumb }).ok,
    ).toBe(false);
  });

  it("a derivative never changes tenancy: the studio/client prefix is carried, never rewritten", () => {
    // The only way a derived key could reach another tenant is by altering one
    // of the first two segments. It alters neither.
    const thumb = buildTreatmentImageThumbPath(foreign) as string;
    const [studioSeg, clientSeg] = thumb.split("/");
    expect(studioSeg).toBe(OTHER_STUDIO);
    expect(clientSeg).toBe(OTHER_CLIENT);
    expect(studioSeg).not.toBe(STUDIO);
  });

  it("a row whose path points at ANOTHER studio's prefix is refused even for its own studio_id", () => {
    // The 0093 shape check and the signer's validator both bind the first two
    // path segments to the row's own ids. A row claiming studio A while its
    // path sits under studio B is rejected, and so is anything derived from it.
    const mismatched = `${OTHER_STUDIO}/${CLIENT}/${IMAGE_ID}.jpg`;
    const args = {
      expectedStudioId: STUDIO,
      rowStudioId: STUDIO,
      rowClientId: CLIENT,
      storageBucket: TREATMENT_IMAGES_BUCKET,
    };
    expect(validateTreatmentImagePath({ ...args, storagePath: mismatched }).ok).toBe(
      false,
    );
    const derived = buildTreatmentImageThumbPath(mismatched) as string;
    expect(validateTreatmentImagePath({ ...args, storagePath: derived }).ok).toBe(
      false,
    );
  });

  it("NO CLIENT INPUT reaches the key: a hostile filename cannot appear in it", () => {
    // The object key is built from server values only (studio, client, a
    // server-side uuid, the DETECTED content type). The uploaded filename is
    // display-only. Neither the original key nor the derived one may contain it.
    const hostile = "../../../etc/passwd\u0000.jpg";
    expect(sanitizeFilename(hostile)).not.toContain("/");

    const key = buildTreatmentImagePath({
      studioId: STUDIO,
      clientId: CLIENT,
      id: IMAGE_ID,
      contentType: "image/jpeg",
    });
    const thumb = buildTreatmentImageThumbPath(key) as string;
    for (const k of [key, thumb]) {
      expect(k).not.toContain("passwd");
      expect(k).not.toContain("..");
      expect(k.split("/")).toHaveLength(3);
    }
    expect(thumb).toBe(`${STUDIO}/${CLIENT}/${IMAGE_ID}.thumb.webp`);
  });

  it("the derivative is not a wedge for a new format: only the four allowed extensions survive", () => {
    // A derived name is always .thumb.webp, so it cannot smuggle in an
    // extension the bucket's CHECK and the signer's allowlist would refuse.
    for (const ct of ["image/jpeg", "image/png", "image/webp"] as const) {
      const key = buildTreatmentImagePath({
        studioId: STUDIO,
        clientId: CLIENT,
        id: IMAGE_ID,
        contentType: ct,
      });
      expect(buildTreatmentImageThumbPath(key)).toBe(
        `${STUDIO}/${CLIENT}/${IMAGE_ID}.thumb.webp`,
      );
    }
  });
});

describe("SOURCE CONTRACT: the derivative introduces no public surface", () => {
  const RUNTIME = [
    "lib/images/treatment-images.ts",
    "lib/images/treatment-image-sanitize.ts",
    "app/(app)/clients/[id]/images/actions.ts",
    "app/(app)/clients/[id]/images/page.tsx",
    "app/(app)/clients/[id]/images/TreatmentImagesManager.tsx",
  ];

  it("no file on this path reaches for a PUBLIC storage URL", () => {
    // The bucket is private (0092 inserts it with public=false). A derivative
    // served through getPublicUrl would be readable without a signature by
    // anyone who learned the key, which is precisely the property signed URLs
    // exist to deny. Nothing here may introduce one.
    for (const rel of RUNTIME) {
      const src = readFileSync(rel, "utf8");
      expect(src, `${rel} reaches for a public URL`).not.toMatch(
        /getPublicUrl|publicUrl/,
      );
    }
  });

  it("every signed URL on this path uses the SHORT shared TTL, never a longer one", () => {
    // A derivative signed for longer than the original would outlive the
    // authorization that produced it. Both signers must use the one constant.
    for (const rel of [
      "app/(app)/clients/[id]/images/actions.ts",
      "app/(app)/clients/[id]/images/page.tsx",
    ]) {
      const src = readFileSync(rel, "utf8");
      const signCalls = src.match(/createSignedUrl\(/g) ?? [];
      expect(signCalls.length, `${rel} has no signer`).toBeGreaterThan(0);
      // No numeric literal TTL anywhere: every call must pass the constant.
      expect(src).not.toMatch(/createSignedUrl\([^)]*,\s*\d+\s*\)/);
    }
  });

  it("the MODAL signer still signs the ROW's own path, not a derivative", () => {
    // Clinical fidelity: the inspection surface must never be handed a
    // downscaled image. This pins the modal action to row.storage_path.
    const src = readFileSync("app/(app)/clients/[id]/images/actions.ts", "utf8");
    expect(src).toMatch(/createSignedUrl\(\s*row\.storage_path/);
    // and it must not derive a thumb key anywhere in that action's file region
    const afterSigner = src.slice(src.indexOf("getTreatmentImageSignedUrlAction"));
    expect(afterSigner).not.toMatch(/buildTreatmentImageThumbPath/);
  });
});

describe("AUTHORIZATION CEILING: a derivative can never out-rank its original", () => {
  const PAGE = "app/(app)/clients/[id]/images/page.tsx";

  it("the thumb key is derived ONLY when the original was successfully signed", () => {
    // The guarantee: a derivative's authorization must never EXCEED the
    // original's. If the original's createSignedUrl fails, no signed URL to
    // derived clinical content may be minted or shipped either — not merely
    // hidden by the grid, but never created.
    const src = readFileSync(PAGE, "utf8");
    expect(src).toMatch(
      /const thumbPath = previewUrl\s*\?\s*buildTreatmentImageThumbPath\(/,
    );
  });

  it("the ORIGINAL is signed BEFORE the derivative is even derived", () => {
    // Ordering is what makes the guard above meaningful: previewUrl must be
    // populated by the original's signer before the derivative consults it.
    const src = readFileSync(PAGE, "utf8");
    const originalSign = src.indexOf("previewUrl = data?.signedUrl");
    const thumbDerive = src.indexOf("const thumbPath = previewUrl");
    expect(originalSign).toBeGreaterThan(-1);
    expect(thumbDerive).toBeGreaterThan(-1);
    expect(originalSign).toBeLessThan(thumbDerive);
  });

  it("the derivative is signed inside the SAME path-validation branch as the original", () => {
    // Neither URL may be minted outside validateTreatmentImagePath's guard.
    const src = readFileSync(PAGE, "utf8");
    const validate = src.indexOf("validateTreatmentImagePath({");
    const thumbSign = src.indexOf("createSignedUrl(thumbPath");
    expect(validate).toBeGreaterThan(-1);
    expect(thumbSign).toBeGreaterThan(validate);
  });
});
