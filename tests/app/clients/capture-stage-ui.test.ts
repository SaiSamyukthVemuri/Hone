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
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => ({ error: null })),
        remove: vi.fn(async () => ({ error: null })),
      })),
    },
  })),
}));
vi.mock("@/lib/images/treatment-image-sanitize", () => ({
  sanitizeTreatmentImage: vi.fn(async () => ({
    ok: true,
    bytes: Buffer.from("sanitized"),
    contentType: "image/jpeg",
    thumbBytes: null,
  })),
}));
const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const SESSION = "33333333-3333-3333-3333-333333333333";
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: "p", active: true },
    studio: { id: STUDIO },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    // Ownership lookups the upload action makes: the client, and the visit.
    from: vi.fn((table: string) => {
      const row = table === "clients" ? { id: CLIENT } : table === "sessions" ? { id: SESSION } : null;
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.is = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
      return chain;
    }),
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      rpcCalls.push({ name, params });
      if (name === "create_treatment_image_metadata") return { data: params.p_id, error: null };
      return rpcResult;
    }),
  })),
}));

import {
  setTreatmentImageCaptureStageAction,
  setClientPortraitAction,
  uploadTreatmentImageAction,
} from "@/app/(app)/clients/[id]/images/actions";

function uploadForm(extra: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("clientId", CLIENT);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  fd.set("file", new File([Buffer.from("jpeg-bytes")], "synthetic.jpg", { type: "image/jpeg" }));
  return fd;
}

beforeEach(() => {
  rpcResult = { data: "img-1", error: null };
  rpcCalls.length = 0;
});

describe("0231 portrait removal action: displayed-image precondition", () => {
  it("passes the displayed photo to the command when clearing", async () => {
    expect(await setClientPortraitAction({ clientId: CLIENT, imageId: null, expectedImageId: "displayed-photo" })).toEqual({ ok: true });
    expect(rpcCalls).toEqual([{ name: "set_client_portrait", params: {
      p_client_id: CLIENT, p_image_id: null, p_expected_image_id: "displayed-photo",
    } }]);
  });

  it("reports a stale-removal conflict without claiming success or disclosing DB text", async () => {
    rpcResult = { data: null, error: { code: "P0231", message: "private database detail" } };
    expect(await setClientPortraitAction({ clientId: CLIENT, imageId: null, expectedImageId: "stale-photo" })).toEqual({
      ok: false, error: "The ID photo changed. Reload and try again.",
    });
  });

  it("sets a photo without a removal precondition and keeps other errors generic", async () => {
    rpcResult = { data: null, error: { code: "23514", message: "private database detail" } };
    expect(await setClientPortraitAction({ clientId: CLIENT, imageId: "new-photo" })).toEqual({
      ok: false, error: "Could not update the ID photo.",
    });
    expect(rpcCalls[0].params).toEqual({ p_client_id: CLIENT, p_image_id: "new-photo", p_expected_image_id: null });
  });
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

  it("KEYBOARD: a choice never disables its own button; all three are disabled only while saving, and focus returns", () => {
    // Before the fix, `disabled={pending || stage === s}` disabled the pressed
    // button, so a keyboard user's focus dropped to <body> after every choice.
    expect(ctl).not.toMatch(/disabled=\{[^}]*stage === s/);
    expect(ctl).toMatch(/aria-pressed=\{stage === s\}\s+disabled=\{pending\}/);
    expect(ctl).toMatch(/pending=\{pending\}\s+busyLabel="Clearing…"/); // Clear is disabled while saving too
    // Pressing the current stage saves nothing.
    expect(ctl).toMatch(/if \(next === stage\) return;/);
    // Focus goes back to the pressed button once the save settles; after a
    // Clear (which unmounts) it moves to "Before".
    expect(ctl).toMatch(/refocus\.current = from;/);
    expect(ctl).toMatch(/if \(pending \|\| !refocus\.current\) return;/);
    expect(ctl).toMatch(/const target = refocus\.current === "clear" && !stage \? "before" : refocus\.current;/);
    expect(ctl).toMatch(/querySelector<HTMLButtonElement>\(`\[data-stage-button="\$\{target\}"\]`\)\?\.focus\(\);/);
    for (const b of ['data-stage-button={s}', 'data-stage-button="clear"']) expect(ctl).toContain(b);
  });

  it("the result is announced in a visually hidden polite live region, with the approved copy", () => {
    expect(ctl).toMatch(/before: "Labelled Before",\s+after: "Labelled After",\s+cleared: "Label cleared",/);
    expect(ctl).toMatch(/<p className="sr-only" aria-live="polite" data-testid="capture-stage-announce">\s*\{announcement\}\s*<\/p>/);
    expect(ctl).toMatch(/setAnnouncement\(ANNOUNCE\[next \?\? "cleared"\]\);/);
  });

  it("the page marks visit photos from session_id and passes the label; the tile renders the control", () => {
    expect(page).toMatch(/practitioner_note, capture_stage, sessions \( started_at, record_status \)/);
    // Never on a LEGACY finalized/void session (0159): no control that can never work.
    expect(page).toMatch(
      /visitPhoto:\s+m\.session_id != null &&\s+session\?\.record_status !== "finalized" &&\s+session\?\.record_status !== "void",/,
    );
    expect(page).toMatch(/captureStage: m\.capture_stage \?\? null,/);
    expect(mgr).toMatch(
      /<CaptureStageControl clientId=\{clientId\} imageId=\{img\.id\} visitPhoto=\{img\.visitPhoto\} stage=\{img\.captureStage\} \/>/,
    );
  });

  it("states where a label is set: on the tile, and (since the upload choice shipped) at attach time", () => {
    // The interim "until the upload choice ships (after #892)" note is retired:
    // the upload panel's radiogroup is pinned below.
    expect(ctl).not.toMatch(/Until the upload choice ships/);
    expect(ctl).toMatch(/on its Photos-tab tile \(the upload panel offers the same choice\s+\/\/ at attach time\)/);
  });
});

describe("0232 at upload: the chosen stage is applied right after the photo is recorded", () => {
  const stageCalls = () => rpcCalls.filter((c) => c.name === "set_treatment_image_capture_stage");

  it("a VISIT photo uploaded with 'before' is created, THEN labelled", async () => {
    const res = await uploadTreatmentImageAction(uploadForm({ sessionId: SESSION, captureStage: "before" }));
    expect(res).toEqual({ ok: true });
    const names = rpcCalls.map((c) => c.name);
    expect(names).toEqual(["create_treatment_image_metadata", "set_treatment_image_capture_stage"]);
    const created = rpcCalls[0].params.p_id;
    expect(stageCalls()[0].params).toEqual({ p_image_id: created, p_client_id: CLIENT, p_stage: "before" });
  });

  it("a failed label NEVER fails the upload: stored, UNLABELLED, and the result says so", async () => {
    rpcResult = { data: null, error: { message: "anything" } };
    expect(await uploadTreatmentImageAction(uploadForm({ sessionId: SESSION, captureStage: "after" }))).toEqual({
      ok: true,
      labelNotSaved: true,
    });
    rpcResult = { data: null, error: null };
    expect(await uploadTreatmentImageAction(uploadForm({ sessionId: SESSION, captureStage: "after" }))).toEqual({
      ok: true,
      labelNotSaved: true,
    });
  });

  it("no label call for a CLIENT photo, for 'not labelled', or for any other value", async () => {
    await uploadTreatmentImageAction(uploadForm({ captureStage: "before" }));
    await uploadTreatmentImageAction(uploadForm({ sessionId: SESSION }));
    await uploadTreatmentImageAction(uploadForm({ sessionId: SESSION, captureStage: "during" }));
    expect(stageCalls()).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.name === "create_treatment_image_metadata")).toHaveLength(3);
  });
});

describe("0232 at upload: the panel choice", () => {
  const mgr = read("TreatmentImagesManager.tsx");

  it("is offered only when attaching to a visit, with no default label, on the 44px floor", () => {
    expect(mgr).toMatch(/\{\(contextKind === "session" \|\| contextKind === "block"\) && \(\s*<div\s+role="radiogroup"\s+aria-label="Taken before or after treatment"/);
    expect(mgr).toMatch(/\["", "Not labelled"\],\s*\["before", "Before treatment"\],\s*\["after", "After treatment"\],/);
    // The "Will attach as" summary names the chosen label (approved copy);
    // nothing when Not labelled, never on a client photo.
    expect(mgr).toMatch(/before: "Labelled: Before treatment\.",\s+after: "Labelled: After treatment\.",/);
    expect(mgr).toContain('<p className="text-xs text-neutral-400" data-testid="upload-attach-summary">');
    expect(mgr).toMatch(/\{contextKind !== "client" && captureStage\s+\? ` \$\{CAPTURE_STAGE_SUMMARY\[captureStage\]\}`\s+: null\}/);
    expect(mgr).toMatch(/useState<"" \| "before" \| "after">\(""\)/);
    expect(mgr).toMatch(/className="flex min-h-\[44px\] items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200"\s*>\s*<input\s+type="radio"\s+name="captureStage"/);
  });

  it("sends the stage only for a visit photo, and reports an unsaved label honestly", () => {
    expect(mgr).toMatch(/if \(contextKind !== "client" && captureStage\) fd\.set\("captureStage", captureStage\);/);
    expect(mgr).toMatch(/"label not saved; set it on the photo"/);
    expect(mgr).toMatch(/f\.note \? `✓ Uploaded \(\$\{f\.note\}\)` : "✓ Uploaded"/);
  });
});


describe("0232 full-size phone photo labelling", () => {
  it("offers the same visit-only label control in preview using refreshed photo state", () => {
    const mgr = read("TreatmentImagesManager.tsx");
    expect(mgr).toMatch(/const modalPhoto = modal \? images.find\(\(image\) => image.id === modal.id\) \?\? null : null;/);
    const preview = mgr.slice(mgr.indexOf('aria-label="Treatment photo preview"'));
    expect(preview).toMatch(/\{modalPhoto && \(\s*<CaptureStageControl[\s\S]*?imageId=\{modalPhoto.id\}[\s\S]*?visitPhoto=\{modalPhoto.visitPhoto\}[\s\S]*?stage=\{modalPhoto.captureStage\}/);
  });
});
