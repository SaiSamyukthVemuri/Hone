import { describe, expect, it } from "vitest";
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
