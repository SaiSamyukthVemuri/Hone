import { describe, expect, it } from "vitest";
import {
  safeReturnPath,
  DEFAULT_RETURN_PATH,
} from "@/lib/google-calendar/config";

// The owner Integrations connection flow passes a return path to the OAuth start /
// disconnect actions. It must be open-redirect-safe: only exact allow-listed
// in-app settings paths are honored; anything else falls back to the default.
describe("safeReturnPath: open-redirect allowlist", () => {
  it("honors the two allow-listed settings paths", () => {
    expect(safeReturnPath("/settings/profile")).toBe("/settings/profile");
    expect(safeReturnPath("/settings/integrations")).toBe("/settings/integrations");
  });

  it("falls back to the default for anything else", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "/dashboard",
      "/settings/integrations/../data",
      "https://evil.example.com",
      "//evil.example.com",
      "http://localhost:3000/settings/integrations",
      "/settings/integrations?x=1",
      "javascript:alert(1)",
      "/SETTINGS/INTEGRATIONS",
    ]) {
      expect(safeReturnPath(bad as string | null | undefined)).toBe(DEFAULT_RETURN_PATH);
    }
  });

  it("the default is a settings path (never an external URL)", () => {
    expect(DEFAULT_RETURN_PATH.startsWith("/settings/")).toBe(true);
  });
});
