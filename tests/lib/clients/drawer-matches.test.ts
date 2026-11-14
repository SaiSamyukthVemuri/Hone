import { describe, expect, it } from "vitest";
import { matchesClientSearch } from "@/lib/clients/name-search";
import { rankDrawerClients } from "@/lib/clients/drawer-matches";

// The booking drawer's "Find existing client" used to filter and take the first 12 ALPHABETICALLY, so with
// more than 12 matches an exact match could be cut off. It now ranks (exact, prefix, word-start, looser, email)
// and THEN caps. Synthetic names only.

const MAX = 12;
const mk = (id: string, name: string, extra: Record<string, string | null> = {}) => ({ id, name, preferred_name: null, email: null, phone: null, ...extra });

describe("drawer client list ranks before it caps", () => {
  it('"kip": the exact name is first, ahead of names that merely contain it', () => {
    const clients = [mk("1", "Bankip Ota"), mk("2", "Kipling Ng"), mk("3", "Kip"), mk("4", "Skip Lee")];
    expect(rankDrawerClients(clients, "kip", MAX).matches.map((c) => c.name)).toEqual(["Kip", "Kipling Ng", "Bankip Ota", "Skip Lee"]);
  });

  it('"zed" with 16 matches: the exact "Zed" is within the 12 shown, and the total is still 16', () => {
    // 15 names that contain "zed" and sort BEFORE "Zed" alphabetically, plus the exact one.
    const others = Array.from({ length: 15 }, (_, i) => mk(`o${i}`, `Azed${String.fromCharCode(65 + i)} Test`));
    const exact = mk("exact", "Zed");
    const { matches, total } = rankDrawerClients([...others, exact], "zed", MAX);
    expect(total).toBe(16);
    expect(matches).toHaveLength(MAX);
    expect(matches[0].name).toBe("Zed");
  });

  it("REVERT CONTROL: the old filter-then-slice-by-name drops the exact match from the same data", () => {
    const others = Array.from({ length: 15 }, (_, i) => mk(`o${i}`, `Azed${String.fromCharCode(65 + i)} Test`));
    const all = [...others, mk("exact", "Zed")];
    const old = all.filter((c) => matchesClientSearch(c, "zed")).sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX);
    expect(old.map((c) => c.name)).not.toContain("Zed");
    expect(rankDrawerClients(all, "zed", MAX).matches.map((c) => c.name)).toContain("Zed");
  });

  it("ties break by name then id, so the order is stable", () => {
    const clients = [mk("b", "Zed Two"), mk("a", "Zed Two"), mk("c", "Zed One")];
    expect(rankDrawerClients(clients, "zed", MAX).matches.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("an empty query keeps the caller's order (just-added clients first) and caps", () => {
    const clients = Array.from({ length: 14 }, (_, i) => mk(`i${i}`, `Name ${14 - i}`));
    const { matches, total } = rankDrawerClients(clients, "  ", MAX);
    expect(matches.map((c) => c.id)).toEqual(clients.slice(0, MAX).map((c) => c.id));
    expect(total).toBe(14);
  });

  it("a preferred-name exact match ranks first too (the drawer searches both names)", () => {
    const clients = [mk("1", "Zedekiah Long"), mk("2", "Legal Name", { preferred_name: "Zed" })];
    expect(rankDrawerClients(clients, "zed", MAX).matches[0].id).toBe("2");
  });
});
