import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRecordsExportPath, RECORDS_EXPORT_HEADER_SOURCE } from "@/lib/clinical-records/route";
import { buildTokenRoutePrivacyHeaders } from "@/lib/security/headers";

// HON-46 (Codex P1 4303921817): the canonical export route that gates client
// telemetry and sets the no-referrer header.

describe("isRecordsExportPath", () => {
  it("matches the export document, with or without a trailing slash", () => {
    expect(isRecordsExportPath("/clients/3f9c2a10-5b7e-4c1d-9a8f-0e1d2c3b4a59/records/export")).toBe(true);
    expect(isRecordsExportPath("/clients/abc/records/export/")).toBe(true);
  });
  it("matches nothing else: not the client record, not a deeper path, not a lookalike", () => {
    for (const p of [
      "/clients/abc",
      "/clients/abc/records",
      "/clients/abc/records/export/extra",
      "/clients/records/export",
      "/x/clients/abc/records/export",
      "/clients/abc/clinical-notes/print",
    ]) {
      expect(isRecordsExportPath(p), p).toBe(false);
    }
  });
  it("the header source names the same document, and its headers are no-referrer", () => {
    expect(RECORDS_EXPORT_HEADER_SOURCE).toBe("/clients/:id/records/export");
    expect(isRecordsExportPath(RECORDS_EXPORT_HEADER_SOURCE.replace(":id", "x"))).toBe(true);
    expect(buildTokenRoutePrivacyHeaders()).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });
});


// The clinical audit RPC is independent of the generic 0242 audit writer.
// A transport acknowledgement alone must never authorize preview or print.
const audit = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: audit.client }));
vi.mock("@/lib/supabase/queries", () => ({ getSessionBlockAreasByBlockIds: vi.fn() }));
import { recordClinicalRecordsAudit } from "@/lib/clinical-records/export-queries";
import { auditThenLoad } from "@/lib/clinical-records/export-scope";

const AUDIT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AUDIT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const metadata = { scope: "day", day: "2026-09-24" };

describe("clinical preview and print require a recorded audit identity", () => {
  beforeEach(() => {
    audit.rpc.mockReset();
    audit.client.mockReset();
    audit.client.mockResolvedValue({ rpc: audit.rpc });
  });

  it("accepts the preview's exact audit row and passes only the scoped RPC contract", async () => {
    audit.rpc.mockResolvedValue({ data: AUDIT_ID, error: null });
    expect(await recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
      action: "clinical_records_previewed", metadata })).toEqual({ ok: true });
    expect(audit.rpc).toHaveBeenCalledExactlyOnceWith("record_clinical_records_audit", {
      p_client_id: CLIENT_ID, p_action: "clinical_records_previewed", p_metadata: metadata, p_id: AUDIT_ID,
    });
  });

  it("accepts a generated print audit identity, with its preview reference intact", async () => {
    audit.rpc.mockResolvedValue({ data: OTHER_AUDIT_ID, error: null });
    const printMetadata = { ...metadata, preview_audit_id: AUDIT_ID };
    expect(await recordClinicalRecordsAudit({ clientId: CLIENT_ID,
      action: "clinical_records_printed", metadata: printMetadata })).toEqual({ ok: true });
    expect(audit.rpc).toHaveBeenCalledExactlyOnceWith("record_clinical_records_audit", {
      p_client_id: CLIENT_ID, p_action: "clinical_records_printed", p_metadata: printMetadata, p_id: null,
    });
  });

  it.each([null, undefined, true, false, {}, [], [AUDIT_ID], "", "not-an-audit-id"])(
    "an error-free transport with invalid audit identity %j cannot load records", async (data) => {
      audit.rpc.mockResolvedValue({ data, error: null });
      const load = vi.fn().mockResolvedValue({ ok: true, value: "synthetic clinical record" });
      expect(await auditThenLoad(() => recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
        action: "clinical_records_previewed", metadata }), load)).toEqual({ ok: false, reason: "audit_failed" });
      expect(load).not.toHaveBeenCalled();
    },
  );

  it("refuses a different valid row id instead of minting a token for an unrecorded preview", async () => {
    audit.rpc.mockResolvedValue({ data: OTHER_AUDIT_ID, error: null });
    expect(await recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
      action: "clinical_records_previewed", metadata })).toEqual({ ok: false });
  });

  it("a plausible id cannot hide a refused RPC", async () => {
    audit.rpc.mockResolvedValue({ data: AUDIT_ID, error: { message: "synthetic private audit refusal" } });
    expect(await recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
      action: "clinical_records_previewed", metadata })).toEqual({ ok: false });
  });

  it.each(["client", "rpc"])("a thrown %s failure returns only refusal without loading or exposing prose", async (where) => {
    const failure = new Error("synthetic private clinical audit transport details");
    if (where === "client") audit.client.mockRejectedValue(failure);
    else audit.rpc.mockRejectedValue(failure);
    const load = vi.fn().mockResolvedValue({ ok: true, value: "synthetic clinical record" });
    expect(await recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
      action: "clinical_records_previewed", metadata })).toEqual({ ok: false });
    expect(await auditThenLoad(() => recordClinicalRecordsAudit({ id: AUDIT_ID, clientId: CLIENT_ID,
      action: "clinical_records_previewed", metadata }), load)).toEqual({ ok: false, reason: "audit_failed" });
    expect(load).not.toHaveBeenCalled();
  });
});
