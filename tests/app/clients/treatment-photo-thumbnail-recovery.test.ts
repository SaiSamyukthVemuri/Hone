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

  it("keeps the opener keyed by image identity while fresh URLs reset recovery state", () => {
    expect(mgr).toMatch(/<GridPhoto\s+key=\{img\.id\}\s+clientId=\{clientId\}/);
    expect(readFileSync("lib/images/use-grid-photo-recovery.ts", "utf8"))
      .toContain("const state = currentGridPhoto(storedState, { previewUrl, thumbUrl });");
    expect(mgr).not.toMatch(/thumbFailed|setBroken/);
  });

  it("the cell stays lazy and drives the SHARED hook with its client and image, never a server action", () => {
    expect(cell).toMatch(/loading="lazy"/);
    expect(cell).toMatch(/useGridPhotoRecovery\(\{ previewUrl, thumbUrl, clientId, imageId \}\)/);
    expect(cell).not.toMatch(/getTreatmentImageSignedUrlAction|from "\.\/actions"/);
    expect(cell).toMatch(/ref=\{imgRef\}/);
    expect(cell).toMatch(/onError=\{onError\}/);
  });

  it("the action delegates to the ONE shared signer (the route uses the same one)", () => {
    const actions = readFileSync(`${DIR}/actions.ts`, "utf8");
    expect(actions).toMatch(/return signTreatmentImageUrl\(studio\.id, \{ imageId: input\.imageId, variant: input\.variant \}\);/);
    // The action stays studio-scoped: it passes no clientId.
    expect(actions).not.toMatch(/signTreatmentImageUrl\([^)]*clientId/);
  });
});

describe("source contract: the shared recovery hook (abortable re-mint + hydration window)", () => {
  const hook = readFileSync("lib/images/use-grid-photo-recovery.ts", "utf8");
  const ctl = readFileSync("lib/images/remint-controller.ts", "utf8");
  const req = readFileSync("lib/images/remint-request.ts", "utf8");

  it("is a client module that imports no application code and no server action", () => {
    expect(hook).toMatch(/^"use client";/);
    for (const src of [hook, ctl, req]) {
      expect(src).not.toMatch(/from "@\/app\//);
      expect(src).not.toMatch(/Action\(|"use server"/);
    }
  });

  it("re-mints through the abortable GET, one controller per cell's server URLs", () => {
    expect(hook).toMatch(/request: \(variant, signal\) => fetchSignedImageUrl\(\{ clientId, imageId, variant, signal \}\)/);
    expect(hook).toMatch(/const key = `\$\{clientId\}\\n\$\{imageId\}\\n\$\{previewUrl \?\? ""\}\\n\$\{thumbUrl \?\? ""\}`;/);
    expect(req).toMatch(/redirect: "manual"/);
    expect(req).toMatch(/cache: "no-store"/);
    expect(req).toMatch(/signal: input\.signal/);
  });

  it("a timeout ABORTS the attempt before the failed path; requests and timers end on unmount and when nothing is pending", () => {
    expect(ctl).toMatch(/a\.timer = setTimeout\(\(\) => \{\s*a\.ac\.abort\(\);\s*fail\(\);\s*\}, timeoutMs\);/);
    expect(ctl).toMatch(/timeoutMs = deps\.timeoutMs \?\? GRID_PHOTO_REMINT_TIMEOUT_MS/);
    expect(hook).toMatch(/controller\.activate\(\);\s*return \(\) => controller\.dispose\(\);/);
    // StrictMode's replay (dispose → activate) re-issues a stranded attempt (Codex 4308035620).
    expect(ctl).toMatch(/activate\(\) \{[\s\S]{0,800}?const p = read\(\)\.pending;\s*if \(p && attempts\.size === 0\) issue\(p\);/);
    expect(hook).toMatch(/if \(!state\.pending\) controller\.settle\(\);/);
    // ...and settle is gated on the LIVE state, so a stale render's effect can
    // never cancel a re-mint an earlier effect just started (Codex P2 4307931365).
    expect(ctl).toMatch(/settle\(\) \{[\s\S]{0,600}?if \(read\(\)\.pending\) return;\s*for \(const a of \[\.\.\.attempts\]\)/);
  });

  it("handles an image that already failed, else listens NATIVELY for a later failure, per src", () => {
    expect(hook).toMatch(/if \(el\.complete && el\.naturalWidth === 0\) \{\s*handleError\(\);\s*return;\s*\}/);
    expect(hook).toMatch(/el\.addEventListener\("error", onNativeError\);/);
    expect(hook).toMatch(/return \(\) => el\.removeEventListener\("error", onNativeError\);/);
    expect(hook).toMatch(/\}, \[state\.src, handleError\]\);/);
    // React's onError and the native listener get the SAME event: one
    // delivery path per event (Codex 4308035614).
    expect(hook).toMatch(/const handleError = useMemo\(\(\) => oncePerErrorEvent\(\(\) => controller\.onImageError\(\)\), \[controller\]\);/);
    expect(hook).toMatch(/const onNativeError = \(e: Event\) => handleError\(e\);/);
    expect(hook).toMatch(/return \{ state, imgRef, onError: handleError \};/);
  });

  it("transitions never run inside a state updater (no duplicate re-mint)", () => {
    expect(hook).not.toMatch(/setState\(\(current\) =>/);
    expect(hook).toMatch(/stateRef\.current = next;\s*setState\(next\);/);
  });
});

describe("source contract: the signed-url route", () => {
  const route = readFileSync("app/api/clients/[clientId]/images/[imageId]/signed-url/route.ts", "utf8");

  it("calls the SHARED signer with the path's clientId and never signs itself", () => {
    expect(route).toMatch(/signTreatmentImageUrl\(\s*studioId,\s*\{ imageId, clientId, variant \},/);
    expect(route).not.toMatch(/createAdminClient|createSignedUrl|service_role/i);
  });

  it("every response is no-store; no CORS header is ever set; nothing is logged", () => {
    expect(route).toMatch(/"Cache-Control": "no-store, private"/);
    expect(route).toMatch(/NextResponse\.json\(body, \{ status, headers: NO_STORE \}\)/);
    expect(route).not.toMatch(/Access-Control/i);
    expect(route).not.toMatch(/console\.|recordOpsAlert|Sentry/);
  });

  it("adds no middleware exemption: the session gate still refuses it first", () => {
    const mw = readFileSync("lib/supabase/middleware.ts", "utf8");
    expect(mw).not.toMatch(/signed-url|\/api\/clients/);
  });
});
