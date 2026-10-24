import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toPerformerOptions } from "@/lib/sessions/performer-options";
import type { Practitioner } from "@/lib/types/database";

// DAT-001 minimal returned fields. The session page handed whole practitioner
// rows to SessionPerformerLine, a client component, so every column (auth
// user id, calendar-feed token hash, terms and privacy acceptance) was
// serialized into the browser's RSC payload, although the line renders only a
// name and the select needs only the id. The page now projects through
// toPerformerOptions.

const FULL_PRACTITIONER: Practitioner = {
  id: "p1", studio_id: "SENTINEL-studio", user_id: "SENTINEL-user",
  display_name: "Visible Name", email: "visible@example.test", role: "owner",
  active: true, color: "SENTINEL-color",
  terms_accepted_at: "SENTINEL-terms-at", terms_version: "SENTINEL-terms-v",
  privacy_accepted_at: "SENTINEL-privacy-at", privacy_version: "SENTINEL-privacy-v",
  calendar_feed_token_hash: "SENTINEL-feed-hash",
  default_machine_frequency: null, created_at: "SENTINEL-created",
} as Practitioner;

describe("DAT-001 SessionPerformerLine receives only what it renders", () => {
  it("projects a practitioner to exactly id, display_name and email", () => {
    expect(toPerformerOptions([FULL_PRACTITIONER])).toEqual([
      { id: "p1", display_name: "Visible Name", email: "visible@example.test" },
    ]);
    expect(JSON.stringify(toPerformerOptions([FULL_PRACTITIONER]))).not.toContain("SENTINEL");
  });

  it("the session page passes the projection, never the whole rows", () => {
    const page = readFileSync("app/(app)/clients/[id]/sessions/[sessionId]/page.tsx", "utf8");
    const start = page.indexOf("<SessionPerformerLine");
    const element = page.slice(start, page.indexOf("/>", start));
    expect(start).toBeGreaterThan(-1);
    expect(element).toMatch(/practitioners=\{toPerformerOptions\(clientData\.practitioners\)\}/);
  });

  it("the client component's prop type is the narrow option, not the row", () => {
    const line = readFileSync("components/session-performer-line.tsx", "utf8");
    expect(line).toMatch(/practitioners: PerformerOption\[\];/);
    expect(line).not.toMatch(/practitioners: Practitioner\[\]/);
  });
});
