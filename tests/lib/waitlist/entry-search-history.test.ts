import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { hitsFromRows, likePattern, mergeReleased, normalizeQuery, SECTION_OF_STATUS } from "@/lib/waitlist/entry-search";
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
    expect(normalizeQuery("  Avery   Example ")).toBe("Avery Example");
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
      { id: E1, name: "Avery Example", status: "waiting", joined_at: "2026-10-01T00:00:00Z" },
      { id: E2, name: "Avery Example", status: "removed", joined_at: "2026-10-02T00:00:00Z" },
      { id: 5, name: "bad", status: "waiting" },
    ]);
    expect(hits.map((h) => [h.id, h.section])).toEqual([[E1, "Active"], [E2, "Archived"]]);
  });
});

describe("the Released list shows the MOST RECENT outcomes first", () => {
  const row = (id: string, status: string, col: string, at: string) => ({ id, name: `n-${id}`, status, joined_at: "2020-01-01T00:00:00Z", [col]: at });
  it("orders expired and released together by their recorded outcome time, newest first, not by join date", () => {
    const m = mergeReleased(
      [row("a", "expired", "expired_at", "2026-11-01T00:00:00Z"), row("c", "expired", "expired_at", "2026-11-10T00:00:00Z")],
      [row("b", "released", "released_at", "2026-11-05T00:00:00Z")],
    );
    expect(m.hits.map((h) => h.id)).toEqual(["c", "b", "a"]);
    expect(m.capped).toBe(false);
  });
  it("past the cap the OLDEST outcomes are cut, the newest stay, and the notice flag is set", () => {
    const expired = Array.from({ length: 60 }, (_, i) => row(`e${String(i).padStart(2, "0")}`, "expired", "expired_at", `2026-10-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
    const released = Array.from({ length: 60 }, (_, i) => row(`r${String(i).padStart(2, "0")}`, "released", "released_at", `2026-11-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`));
    const m = mergeReleased(expired, released, 100);
    expect(m.hits).toHaveLength(100);
    expect(m.capped).toBe(true);
    const newest = Date.parse("2026-11-28T00:00:00Z");
    expect(m.hits.some((h) => h.id.startsWith("r"))).toBe(true);
    // every released entry (all newer than every expired one) survives; only expired ones are cut
    expect(m.hits.filter((h) => h.id.startsWith("r"))).toHaveLength(60);
    expect(newest).toBeGreaterThan(0);
  });
  it("a malformed row in the middle does not shift later rows onto the wrong time", () => {
    // Correct order by time: B (Nov 20), C (Nov 10), A (Nov 1). A positional zip would give B the malformed row's time (Jan 1),
    // C the time of B and A its own, which orders C, A, B instead.
    const m = mergeReleased(
      [
        row("A", "expired", "expired_at", "2026-11-01T00:00:00Z"),
        { id: 99, name: "malformed", status: "expired", expired_at: "2026-01-01T00:00:00Z" },
        row("B", "expired", "expired_at", "2026-11-20T00:00:00Z"),
        row("C", "expired", "expired_at", "2026-11-10T00:00:00Z"),
      ],
      [],
    );
    expect(m.hits.map((h) => h.id)).toEqual(["B", "C", "A"]);
  });
  it("a malformed row among the released ones is dropped without disturbing the merge across states", () => {
    // Correct: R2 (Nov 15), E1 (Nov 12), R1 (Nov 1). A positional zip would give R2 the id-less row's time (Jan 1) and R1 R2's.
    const m = mergeReleased(
      [row("E1", "expired", "expired_at", "2026-11-12T00:00:00Z")],
      [
        row("R1", "released", "released_at", "2026-11-01T00:00:00Z"),
        { name: "no id", status: "released", released_at: "2026-01-01T00:00:00Z" },
        row("R2", "released", "released_at", "2026-11-15T00:00:00Z"),
      ],
    );
    expect(m.hits.map((h) => h.id)).toEqual(["R2", "E1", "R1"]);
  });
  it("an entry with no recorded time sorts last rather than first", () => {
    const m = mergeReleased([{ id: "x", name: "n", status: "expired" }], [row("y", "released", "released_at", "2026-11-05T00:00:00Z")]);
    expect(m.hits.map((h) => h.id)).toEqual(["y", "x"]);
  });
  it("the read orders each state newest-first by its own outcome column and never by join date", () => {
    const s = read("lib/waitlist/entry-search.ts");
    // nullsFirst:false so the database cut matches the in-memory rule that an entry with no recorded time sorts LAST.
    expect(s).toContain(".order(col, { ascending: false, nullsFirst: false })");
    expect(s).toContain('read("expired", "expired_at")');
    expect(s).toContain('read("released", "released_at")');
    expect(s).toContain(".limit(RELEASED_LIMIT + 1)");
    const fn = s.slice(s.indexOf("export async function listReleasedEntries"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toContain('order("joined_at"');
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
