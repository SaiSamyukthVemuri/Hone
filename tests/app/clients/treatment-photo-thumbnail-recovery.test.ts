import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

// FETT photos (HON-43): thumbnail recovery after a signed URL expires.
//
// The grid re-mints an expired derivative through getTreatmentImageSignedUrlAction
// with `variant: "thumb"`. That variant must carry EXACTLY the authorization of
// the original: the same studio-scoped, unarchived row read and the same path
// validation, and it signs the original before the derivative (authorization
// ceiling). Proved behaviourally against an in-memory table that applies the
// action's own query filters, so a dropped filter changes what the mock returns.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const OTHER_STUDIO = "99999999-9999-9999-9999-999999999999";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const PRACT = "44444444-4444-4444-4444-444444444444";
const IMG = "33333333-3333-3333-3333-333333333333";
const PATH = `${STUDIO}/${CLIENT}/${IMG}.png`;

type Row = {
  id: string;
  studio_id: string;
  client_id: string;
  storage_bucket: string;
  storage_path: string;
  deleted_at: string | null;
};
let table: Row[] = [];
let member = true;
const signed: string[] = [];
let missingObjects = new Set<string>();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => {
    // A non-member never gets past the auth gate (the real one redirects).
    if (!member) throw new Error("NEXT_REDIRECT");
    return { practitioner: { id: PRACT, active: true }, studio: { id: STUDIO } };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn(() => {
      const filters: Array<(r: Row) => boolean> = [];
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn((col: keyof Row, v: unknown) => {
        filters.push((r) => r[col] === v);
        return chain;
      });
      chain.is = vi.fn((col: keyof Row, v: unknown) => {
        filters.push((r) => r[col] === v);
        return chain;
      });
      chain.maybeSingle = vi.fn(async () => ({
        data: table.find((r) => filters.every((f) => f(r))) ?? null,
        error: null,
      }));
      return chain;
    }),
  })),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        createSignedUrl: vi.fn(async (path: string) => {
          signed.push(path);
          if (missingObjects.has(path)) return { data: null, error: { message: "Object not found" } };
          return { data: { signedUrl: `signed:${path}` }, error: null };
        }),
      })),
    },
  })),
}));

import { getTreatmentImageSignedUrlAction } from "@/app/(app)/clients/[id]/images/actions";

function row(over: Partial<Row> = {}): Row {
  return {
    id: IMG,
    studio_id: STUDIO,
    client_id: CLIENT,
    storage_bucket: "treatment-images",
    storage_path: PATH,
    deleted_at: null,
    ...over,
  };
}

beforeEach(() => {
  table = [row()];
  member = true;
  signed.length = 0;
  missingObjects = new Set();
});

describe("the thumb variant: same authorization as the original", () => {
  it("positive control: a member gets a fresh derivative URL, signed AFTER the original", async () => {
    const res = await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" });
    expect(res).toEqual({ ok: true, url: `signed:${STUDIO}/${CLIENT}/${IMG}.thumb.webp` });
    expect(signed).toEqual([PATH, `${STUDIO}/${CLIENT}/${IMG}.thumb.webp`]);
  });

  it("no variant (the preview modal) still gets the ORIGINAL", async () => {
    expect(await getTreatmentImageSignedUrlAction({ imageId: IMG })).toEqual({ ok: true, url: `signed:${PATH}` });
  });

  it("a NON-MEMBER gets no thumb URL (and nothing is signed)", async () => {
    member = false;
    await expect(getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).rejects.toThrow();
    expect(signed).toEqual([]);
  });

  it("ANOTHER STUDIO's photo gets no thumb URL", async () => {
    table = [row({ studio_id: OTHER_STUDIO, storage_path: `${OTHER_STUDIO}/${CLIENT}/${IMG}.png` })];
    expect(await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).toEqual({
      ok: false,
      error: "Image not available.",
    });
    expect(signed).toEqual([]);
  });

  it("an ARCHIVED photo gets no thumb URL", async () => {
    table = [row({ deleted_at: "2026-10-17T00:00:00Z" })];
    expect((await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).ok).toBe(false);
    expect(signed).toEqual([]);
  });

  it("a row whose path does not bind to its studio/client gets no thumb URL", async () => {
    table = [row({ storage_path: `${OTHER_STUDIO}/${CLIENT}/${IMG}.png` })];
    expect((await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).ok).toBe(false);
    expect(signed).toEqual([]);
  });

  it("CEILING: if the original will not sign, no derivative is minted", async () => {
    missingObjects.add(PATH);
    expect((await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).ok).toBe(false);
    expect(signed).toEqual([PATH]);
  });

  it("a legacy photo with no derivative is simply not available (the grid then shows the original)", async () => {
    missingObjects.add(`${STUDIO}/${CLIENT}/${IMG}.thumb.webp`);
    expect((await getTreatmentImageSignedUrlAction({ imageId: IMG, variant: "thumb" })).ok).toBe(false);
  });
});

describe("source contract: the grid recovers through GridPhoto", () => {
  const DIR = "app/(app)/clients/[id]/images";
  const mgr = readFileSync(`${DIR}/TreatmentImagesManager.tsx`, "utf8");
  const cell = readFileSync(`${DIR}/GridPhoto.tsx`, "utf8");

  it("the grid renders GridPhoto keyed by the server URLs, so router.refresh() revives a dead cell", () => {
    expect(mgr).toMatch(/<GridPhoto\s+key=\{`\$\{img\.id\}:\$\{img\.previewUrl \?\? ""\}:\$\{img\.thumbUrl \?\? ""\}`\}/);
    expect(mgr).not.toMatch(/thumbFailed|setBroken/);
  });

  it("the cell stays lazy, re-mints through the shared action, and checks for a pre-hydration failure", () => {
    expect(cell).toMatch(/loading="lazy"/);
    expect(cell).toMatch(/getTreatmentImageSignedUrlAction\(\{ imageId, variant \}\)/);
    expect(cell).toMatch(/if \(el\.complete && el\.naturalWidth === 0\) \{\s*handleError\(\);\s*return;\s*\}/);
    // The hydration-window race: a NATIVE error listener per src, removed on cleanup.
    expect(cell).toMatch(/el\.addEventListener\("error", onNativeError\);/);
    expect(cell).toMatch(/return \(\) => el\.removeEventListener\("error", onNativeError\);/);
    expect(cell).toMatch(/\}, \[state\.src, handleError\]\);/);
    // Transitions never run inside a state updater (no duplicate re-mint).
    expect(cell).not.toMatch(/setState\(\(current\) =>/);
  });
});
