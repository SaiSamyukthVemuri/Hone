import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// FETT photos (HON-43), 0232: the before/after label on a Photos-tab tile.
// The database rules (visit-only, actor, two values) are proved in
// tests/db/treatment-image-capture-stage.db.test.ts; here, the UI contract
// and the server action's own guards.

const ROOT = process.cwd();
const DIR = "app/(app)/clients/[id]/images";
const read = (f: string) => readFileSync(join(ROOT, DIR, f), "utf8");

let rpcResult: { data: unknown; error: unknown } = { data: "img-1", error: null };
const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "p", active: true },
    studio: { id: "s" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      return rpcResult;
    }),
  })),
}));

import { setTreatmentImageCaptureStageAction } from "@/app/(app)/clients/[id]/images/actions";

beforeEach(() => {
  rpcResult = { data: "img-1", error: null };
  rpcCalls.length = 0;
});

describe("0232 action: setTreatmentImageCaptureStageAction", () => {
  it("sets, changes and clears through the 0232 command", async () => {
    for (const stage of ["before", "after", null] as const) {
      expect(await setTreatmentImageCaptureStageAction({ imageId: "img-1", clientId: "c-1", stage })).toEqual({ ok: true });
    }
    expect(rpcCalls.map((c) => c.params.p_stage)).toEqual(["before", "after", null]);
    expect(rpcCalls.every((c) => c.name === "set_treatment_image_capture_stage")).toBe(true);
    expect(rpcCalls[0].params).toEqual({ p_image_id: "img-1", p_client_id: "c-1", p_stage: "before" });
  });

  it("refuses any other value BEFORE reaching the database", async () => {
    const res = await setTreatmentImageCaptureStageAction({
      imageId: "img-1",
      clientId: "c-1",
      stage: "during" as unknown as "before",
    });
    expect(res).toEqual({ ok: false, error: "Choose before or after." });
    expect(rpcCalls).toHaveLength(0);
  });

  it("a NULL result (not this client's photo, archived, or another studio) is the generic not-found", async () => {
    rpcResult = { data: null, error: null };
    expect(await setTreatmentImageCaptureStageAction({ imageId: "x", clientId: "c-1", stage: "after" })).toEqual({
      ok: false,
      error: "Treatment photo not found.",
    });
  });

  it("a database error never forwards its message", async () => {
    rpcResult = { data: null, error: { message: "Only a photo from a visit can be marked before or after." } };
    expect(await setTreatmentImageCaptureStageAction({ imageId: "x", clientId: "c-1", stage: "after" })).toEqual({
      ok: false,
      error: "Could not update the photo label.",
    });
  });
});

describe("0232 UI: the tile control", () => {
  const ctl = read("CaptureStageControl.tsx");
  const page = read("page.tsx");
  const mgr = read("TreatmentImagesManager.tsx");

  it("is offered ONLY on visit photos, on the touch-floor primitive, with generic errors", () => {
    expect(ctl).toMatch(/if \(!visitPhoto\) return null;/);
    expect(ctl).toMatch(/import \{ Button \} from "@\/components\/ui\/button";/);
    expect(ctl).not.toMatch(/<button\b/);
    expect(ctl).toMatch(/setTreatmentImageCaptureStageAction\(\{ imageId, clientId, stage: next \}\)/);
    expect(ctl).toMatch(/aria-pressed=\{stage === s\}/);
    expect(ctl).toMatch(/Clear label/);
    expect(ctl).not.toMatch(/error\.message/);
  });

  it("the page marks visit photos from session_id and passes the label; the tile renders the control", () => {
    expect(page).toMatch(/practitioner_note, capture_stage, sessions/);
    expect(page).toMatch(/visitPhoto: m\.session_id != null,/);
    expect(page).toMatch(/captureStage: m\.capture_stage \?\? null,/);
    expect(mgr).toMatch(
      /<CaptureStageControl clientId=\{clientId\} imageId=\{img\.id\} visitPhoto=\{img\.visitPhoto\} stage=\{img\.captureStage\} \/>/,
    );
  });

  it("states the interim behaviour: label right after attach, until the upload choice ships", () => {
    expect(ctl).toMatch(/Until the upload choice ships \(after #892\), a photo is labelled right\s+\/\/ after it is attached, from here\./);
  });
});
