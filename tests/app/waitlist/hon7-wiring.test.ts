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

describe("the window estimate action", () => {
  it("refuses a non-owner before it builds the admin client", () => {
    expect(CAPACITY.indexOf('practitioner.role !== "owner"')).toBeGreaterThan(0);
    expect(CAPACITY.indexOf('practitioner.role !== "owner"')).toBeLessThan(CAPACITY.indexOf("createAdminClient()"));
  });
  it("takes the studio from the session, never from its input", () => {
    expect(CAPACITY).toMatch(/getCurrentPractitionerWithStudio\(\)/);
    expect(CAPACITY).not.toMatch(/input\.studio/);
  });
});
