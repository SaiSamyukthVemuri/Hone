import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hitsFromRows, likePattern, normalizeQuery, SECTION_OF_STATUS } from "@/lib/waitlist/entry-search";
import { describeInvitation, historyFromRows, outcomeOf, type InvitationFacts } from "@/lib/waitlist/invitation-history";
import { InvitationFacts as FactsView } from "@/components/waitlist/invitation-facts";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const E1 = "00000000-0000-4000-8000-0000000000e1";
const E2 = "00000000-0000-4000-8000-0000000000e2";
const NOW = Date.parse("2026-11-18T12:00:00Z");
const base: InvitationFacts = {
  invitationId: "i1", issuedAt: "2026-11-10T15:00:00Z", expiresAt: "2026-11-12T15:00:00Z",
  redeemedAt: null, expiredAt: null, releasedAt: null, declinedAt: null,
};

describe("search input", () => {
  it("needs two characters, collapses spaces, bounds length, escapes LIKE wildcards", () => {
    expect(normalizeQuery("a")).toBeNull();
    expect(normalizeQuery("  Sam   Sample ")).toBe("Sam Sample");
    expect(normalizeQuery("x".repeat(200))!.length).toBe(60);
    expect(normalizeQuery(null)).toBeNull();
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("search results are labelled by section, and same-name people stay separate", () => {
  it("maps every status to one section", () => {
    expect(SECTION_OF_STATUS).toMatchObject({
      waiting: "Active", claimed: "Active", invited: "Active",
      expired: "Released", released: "Released", removed: "Archived", converted: "Booked",
    });
  });
  it("two entries with the same name are two hits, each with its own section and id", () => {
    const hits = hitsFromRows([
      { id: E1, name: "Sam Sample", status: "waiting", joined_at: "2026-10-01T00:00:00Z" },
      { id: E2, name: "Sam Sample", status: "removed", joined_at: "2026-10-02T00:00:00Z" },
      { id: 5, name: "bad", status: "waiting" },
    ]);
    expect(hits.map((h) => [h.id, h.section])).toEqual([[E1, "Active"], [E2, "Archived"]]);
  });
});

describe("invitation facts: recorded, never inferred", () => {
  it("separates the deadline from the expiry-recorded time", () => {
    const f = { ...base, expiredAt: "2026-11-13T09:30:00Z" };
    const d = describeInvitation(f, "America/Toronto", NOW);
    expect(d.outcome).toBe("Expired (not booked within the window)");
    const labels = d.facts.map((x) => x.label);
    expect(labels).toEqual(["Invited", "Deadline", "Expiry recorded at"]);
    const deadline = d.facts.find((x) => x.label === "Deadline")!.value;
    const recorded = d.facts.find((x) => x.label === "Expiry recorded at")!.value;
    expect(deadline).not.toBe(recorded);
  });
  it("renders times in the studio timezone", () => {
    const d = describeInvitation(base, "America/Toronto", NOW);
    expect(d.facts[1]!.value).toContain("10:00");
  });
  it("each terminal outcome has its own label and a release says the reason is not recorded", () => {
    expect(outcomeOf({ ...base, declinedAt: "2026-11-11T00:00:00Z" }, NOW)).toBe("declined");
    expect(outcomeOf({ ...base, redeemedAt: "2026-11-11T00:00:00Z" }, NOW)).toBe("booked_link_used");
    expect(outcomeOf({ ...base, releasedAt: "2026-11-11T00:00:00Z" }, NOW)).toBe("released");
    expect(describeInvitation({ ...base, releasedAt: "2026-11-11T00:00:00Z" }, "UTC", NOW).outcome).toBe("Released (reason not recorded)");
  });
  it("a passed deadline with nothing recorded is stated as exactly that, and an open one as open", () => {
    expect(describeInvitation(base, "UTC", NOW).outcome).toBe("Deadline passed (expiry not yet recorded)");
    expect(outcomeOf({ ...base, expiresAt: "2026-11-20T00:00:00Z" }, NOW)).toBe("open");
  });
  it("history groups by entry id, newest first, and drops malformed rows", () => {
    const m = historyFromRows([
      { id: "a", entry_id: E1, issued_at: "2026-11-01T00:00:00Z", expires_at: "2026-11-03T00:00:00Z" },
      { id: "b", entry_id: E1, issued_at: "2026-11-05T00:00:00Z", expires_at: "2026-11-07T00:00:00Z" },
      { id: "c", entry_id: E2, issued_at: "garbage", expires_at: "2026-11-07T00:00:00Z" },
    ]);
    expect(m.get(E1)!.map((f) => f.invitationId)).toEqual(["b", "a"]);
    expect(m.has(E2)).toBe(false);
  });
  it("the view says plainly when there is no history or it could not be read", () => {
    const html = (h: InvitationFacts[] | null) => renderToStaticMarkup(createElement(FactsView, { entryId: E1, history: h, timeZone: "UTC", nowMs: NOW }));
    expect(html([])).toContain("No invitation has been recorded");
    expect(html(null)).toContain("unavailable just now");
    expect(html([{ ...base, expiredAt: "2026-11-13T09:30:00Z" }])).toContain("Expiry recorded at");
  });
});

describe("source guards", () => {
  const SEARCH = read("app/(app)/settings/waitlist/search/page.tsx");
  const NEW = ["lib/waitlist/entry-search.ts", "lib/waitlist/invitation-history.ts", "lib/waitlist/invitation-history-server.ts", "components/waitlist/invitation-facts.tsx", "app/(app)/settings/waitlist/search/page.tsx"];
  it("the search page refuses a non-owner before it reads", () => {
    expect(SEARCH.indexOf('practitioner.role !== "owner"')).toBeLessThan(SEARCH.indexOf("searchWaitlistEntries("));
    expect(SEARCH.indexOf('practitioner.role !== "owner"')).toBeLessThan(SEARCH.indexOf("loadInvitationHistory("));
  });
  it("the reads are server-only, session-scoped to the studio and write nothing", () => {
    for (const f of ["lib/waitlist/entry-search.ts", "lib/waitlist/invitation-history-server.ts"]) {
      const src = read(f);
      expect(src).toContain('import "server-only"');
      expect(src).toContain('.eq("studio_id", studioId)');
      expect(src).toContain('from "@/lib/supabase/server"');
    }
    for (const f of NEW) expect(read(f)).not.toMatch(/admin-server|createAdminClient|\.(insert|update|upsert|delete|rpc)\(/);
  });
  it("search matches the NAME only, never email or phone", () => {
    const s = read("lib/waitlist/entry-search.ts");
    expect(s).toContain('.ilike("name"');
    expect(s).not.toMatch(/ilike\("(email|phone)"/);
    expect(s).toContain('.select("id,name,status,joined_at")');
  });
  it("nothing says an owner cancelled: the actor cannot prove it", () => {
    for (const f of NEW) {
      const code = read(f).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"); // comments may explain why it is never said
      expect(code).not.toMatch(/owner[- ]cancel|cancelled by the owner|owner cancelled/i);
    }
  });
  it("the client-safe presentation imports no server module", () => {
    expect(read("components/waitlist/invitation-facts.tsx")).not.toMatch(/server-only|supabase\/server|invitation-history-server/);
    expect(read("lib/waitlist/invitation-history.ts")).not.toMatch(/^import /m);
  });
});
