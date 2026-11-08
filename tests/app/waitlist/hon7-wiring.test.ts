import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// HON-7 source contracts from the Privacy and Insurance reads of 0313.

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const strip = (s: string) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const ACTIONS = strip(read("app/(app)/settings/waitlist/actions.ts"));
const PAGE = strip(read("app/(app)/settings/waitlist/page.tsx"));
const BOOK = strip(read("app/book/[slug]/actions.ts"));
const CAPACITY = strip(read("app/(app)/settings/waitlist/window-capacity-actions.ts"));

describe("L3 — the follow-up resolver's actor comes from the session", () => {
  it("passes the signed-in owner's user id and nothing the browser sent", () => {
    expect(ACTIONS).toMatch(/const actorUserId = practitioner\.user_id;/);
    const call = ACTIONS.match(/resolve_waitlist_invitation_followup", \{[\s\S]*?\}\);/);
    expect(call).not.toBeNull();
    expect(call![0]).toMatch(/p_actor_user_id: actorUserId/);
    expect(call![0]).toMatch(/p_studio_id: studio\.id/);
    expect(call![0]).not.toMatch(/formData/);
  });
});

describe("L4 — an unexpected command error is never echoed or logged", () => {
  it("the uncertain-outcome block neither reads nor logs the error's text", () => {
    const start = BOOK.indexOf("if (invitedCommand && rpcErr) {");
    const end = BOOK.indexOf('return invitationBookingIndeterminate("command_error");', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = BOOK.slice(start, end);
    expect(block).not.toMatch(/rpcErr\.(message|details|hint)/);
    expect(block).not.toMatch(/JSON\.stringify\(\s*rpcErr/);
  });
});

describe("L6 — the owner settings page is owner-gated before it reads prospects", () => {
  it("returns the owner-only notice before the needs-attention read", () => {
    const gate = PAGE.indexOf('practitioner.role !== "owner"');
    const read = PAGE.indexOf("await loadNeedsAttention(");
    expect(gate).toBeGreaterThan(0);
    expect(read).toBeGreaterThan(gate);
  });
});

describe("N3/N4 — the estimate counts every service; a failed resolve is logged without detail", () => {
  it("does not filter live invitations by service (the studio is one calendar)", () => {
    expect(CAPACITY).not.toMatch(/scope_service_id/);
  });
  it("logs a failed resolve by code only", () => {
    const m = ACTIONS.match(/waitlist_followup_resolve_failed[\s\S]*?\}\),/);
    expect(m).not.toBeNull();
    // The classified code (dbErrorCode), never the raw one: the log contract forbids a raw `.code`.
    expect(m![0]).toMatch(/outcome: dbErrorCode\(resolveError\)/);
    expect(m![0]).not.toMatch(/resolveError\.code/);
    expect(m![0]).not.toMatch(/resolveError\.(message|details|hint)/);
  });
});

describe("the window estimate action", () => {
  it("estimates over the SAME inclusive studio-local dates the invitation is issued over", () => {
    // Today through today + windowDays - 1 (windowToDates), stepped as calendar
    // dates: epoch-millisecond arithmetic shifts or repeats a day across DST.
    expect(CAPACITY).toMatch(/addDays\(first, i\)/);
    expect(CAPACITY).toMatch(/for \(let i = 0; i < input\.windowDays; i \+= 1\)/);
    expect(CAPACITY).not.toMatch(/86_400_000/);
  });
  it("refuses a non-owner before it builds the admin client", () => {
    expect(CAPACITY.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(0);
    expect(CAPACITY.indexOf('practitioner.role !== "owner"')).toBeLessThan(CAPACITY.indexOf("createAdminClient()"));
  });
  it("takes the studio from the session, never from its input", () => {
    expect(CAPACITY).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(CAPACITY).not.toMatch(/input\.studio/);
  });
});

describe("HON-7 C1: the capacity count reads invitations as the owner, not as service_role", () => {
  const SRC = readFileSync(join(__dirname, "..", "..", "..", "app/(app)/settings/waitlist/window-capacity-actions.ts"), "utf8");

  it("issues the invitations select through the session client, never the admin client", () => {
    const at = SRC.indexOf('.from("new_client_waitlist_invitations")');
    expect(at).toBeGreaterThan(0);
    const before = SRC.slice(Math.max(0, at - 160), at);
    expect(before).toContain("session");
    expect(before).not.toContain("admin");
    expect(SRC).toContain('from "@/lib/supabase/server"');
  });
});
