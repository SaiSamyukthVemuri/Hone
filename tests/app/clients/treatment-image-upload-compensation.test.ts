import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ===========================================================================
// L18 Phase 4 — the upload's storage/metadata boundary.
// ===========================================================================
//
// Storage and Postgres are two planes and CANNOT share a transaction: the
// sanitized bytes go to the private bucket through the SERVICE-ROLE storage
// client, and the metadata row is written through the AUTHENTICATED database
// client via create_treatment_image_metadata (migration 0168).
//
// Moving the metadata write onto a command does NOT make that atomic. These
// cases pin the compensation that covers the gap:
//
//   * bytes are uploaded BEFORE the metadata command runs;
//   * a metadata failure REMOVES the uploaded object;
//   * a cleanup failure raises the CRITICAL orphaned-object alert;
//   * a metadata SUCCESS never removes the object.
//
// If a future change deletes the cleanup because "the command is transactional",
// these fail.

const STUDIO = "11111111-1111-1111-1111-111111111111";
const CLIENT = "22222222-2222-2222-2222-222222222222";
const PRACT = "44444444-4444-4444-4444-444444444444";

const order: string[] = [];
const removed: string[][] = [];
const alerts: Array<{ severity: string; event: string }> = [];

let uploadError: unknown = null;
let removeError: unknown = null;
let rpcResult: { data: unknown; error: unknown } = { data: "img", error: null };
let lastRpc: { name: string; params: Record<string, unknown> } | null = null;

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: vi.fn(async () => ({
    practitioner: { id: PRACT, active: true },
    studio: { id: STUDIO },
  })),
}));
// Table-aware read mock: the ownership lookup must find the client, or the
// action returns "Client not found." before reaching any storage work.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: vi.fn((table: string) => {
      const row = table === "clients" ? { id: CLIENT } : null;
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.is = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({ data: row, error: null }));
      return chain;
    }),
    rpc: vi.fn(async (name: string, params: Record<string, unknown>) => {
      order.push("metadata");
      lastRpc = { name, params };
      return rpcResult;
    }),
  })),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: vi.fn(() => ({
    storage: {
      from: vi.fn(() => ({
        upload: vi.fn(async () => {
          order.push("upload");
          return { error: uploadError };
        }),
        remove: vi.fn(async (paths: string[]) => {
          order.push("remove");
          removed.push(paths);
          return { error: removeError };
        }),
      })),
    },
  })),
}));
vi.mock("@/lib/ops/alerts", () => ({
  recordOpsAlert: vi.fn(async (a: { severity: string; event: string }) => {
    alerts.push({ severity: a.severity, event: a.event });
  }),
}));
vi.mock("@/lib/images/treatment-image-sanitize", () => ({
  sanitizeTreatmentImage: vi.fn(async () => ({
    ok: true,
    bytes: Buffer.from("sanitized-bytes"),
    contentType: "image/jpeg",
  })),
}));

import { uploadTreatmentImageAction } from "@/app/(app)/clients/[id]/images/actions";

function formData(): FormData {
  const fd = new FormData();
  fd.set("clientId", CLIENT);
  fd.set(
    "file",
    new File([Buffer.from("original-bytes")], "photo.jpg", { type: "image/jpeg" }),
  );
  return fd;
}

afterEach(() => {
  order.length = 0;
  removed.length = 0;
  alerts.length = 0;
  uploadError = null;
  removeError = null;
  rpcResult = { data: "img", error: null };
  lastRpc = null;
  vi.clearAllMocks();
});

describe("upload: storage first, then the metadata command", () => {
  it("uploads the sanitized bytes BEFORE calling the metadata command", async () => {
    await uploadTreatmentImageAction(formData());
    expect(order[0]).toBe("upload");
    expect(order).toContain("metadata");
    expect(order.indexOf("upload")).toBeLessThan(order.indexOf("metadata"));
  });

  it("calls create_treatment_image_metadata, sending no studio or uploader", async () => {
    await uploadTreatmentImageAction(formData());
    expect(lastRpc?.name).toBe("create_treatment_image_metadata");
    expect(lastRpc?.params.p_client_id).toBe(CLIENT);
    expect(lastRpc?.params.p_storage_bucket).toBe("treatment-images");
    // Derived inside the command from auth.uid().
    expect(lastRpc?.params).not.toHaveProperty("p_studio_id");
    expect(lastRpc?.params).not.toHaveProperty("p_uploaded_by");
  });

  it("does NOT remove the object when metadata creation succeeds", async () => {
    const res = await uploadTreatmentImageAction(formData());
    expect(res).toEqual({ ok: true });
    expect(order).not.toContain("remove");
    expect(removed).toHaveLength(0);
    expect(alerts).toHaveLength(0);
  });
});

describe("upload: compensation when the planes disagree", () => {
  it("REMOVES the uploaded object when the metadata command fails", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    const res = await uploadTreatmentImageAction(formData());
    expect(res.ok).toBe(false);
    // The object must not be left orphaned.
    expect(order).toEqual(["upload", "metadata", "remove"]);
    expect(removed).toHaveLength(1);
    expect(alerts).toContainEqual({
      severity: "warning",
      event: "treatment_image_metadata_insert_failed",
    });
  });

  it("raises the CRITICAL orphan alert when the cleanup ALSO fails", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    removeError = { message: "storage down" };
    const res = await uploadTreatmentImageAction(formData());
    expect(res.ok).toBe(false);
    expect(alerts).toContainEqual({
      severity: "critical",
      event: "treatment_image_orphan_cleanup_failed",
    });
  });

  it("never calls the metadata command when the upload itself failed", async () => {
    uploadError = { message: "no bucket" };
    const res = await uploadTreatmentImageAction(formData());
    expect(res.ok).toBe(false);
    expect(order).toEqual(["upload"]);
    expect(alerts).toContainEqual({
      severity: "warning",
      event: "treatment_image_upload_failed",
    });
  });

  it("surfaces no provider detail in any failure message", async () => {
    rpcResult = { data: null, error: { message: "duplicate key value violates x_pkey" } };
    const res = await uploadTreatmentImageAction(formData());
    if (!res.ok) {
      expect(res.error).not.toMatch(/duplicate key|pkey|constraint/i);
    }
  });
});

describe("upload source shape: the boundary is documented and intact", () => {
  const ACTIONS = readFileSync(
    join(process.cwd(), "app/(app)/clients/[id]/images/actions.ts"),
    "utf8",
  );

  it("keeps sanitization, size validation and the service-role upload", () => {
    expect(ACTIONS).toMatch(/sanitizeTreatmentImage/);
    expect(ACTIONS).toMatch(/validateTreatmentImageUpload/);
    expect(ACTIONS).toMatch(/TREATMENT_IMAGE_MAX_BYTES/);
    expect(ACTIONS).toMatch(/createAdminClient\(\)/);
    expect(ACTIONS).toMatch(/\.upload\(storagePath, sanitized\.bytes/);
  });

  it("keeps the compensating removal and both ops alerts", () => {
    expect(ACTIONS).toMatch(/\.remove\(\[storagePath\]\)/);
    expect(ACTIONS).toMatch(/treatment_image_orphan_cleanup_failed/);
    expect(ACTIONS).toMatch(/treatment_image_metadata_insert_failed/);
    expect(ACTIONS).toMatch(/severity: rmErr \? "critical" : "warning"/);
  });

  it("states that the two planes are not one transaction", () => {
    expect(ACTIONS).toMatch(/cannot\s+\*?\s*\n?\s*\/\/\s*share a transaction|share a transaction/);
    expect(ACTIONS).toMatch(/Nothing here makes the upload atomic/i);
  });

  it("leaves the signed-URL read path unchanged and read-only", () => {
    const SIGNED = ACTIONS.slice(
      ACTIONS.indexOf("export async function getTreatmentImageSignedUrlAction"),
    );
    expect(SIGNED).toMatch(/createSignedUrl/);
    expect(SIGNED).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(SIGNED).not.toMatch(/\.remove\(/);
  });
});
