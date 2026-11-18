import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contactsFromRows, mailtoHref, telHref } from "@/lib/waitlist/reply-contact-pure";

const ROOT = join(__dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

describe("contactsFromRows: joined by ENTRY ID", () => {
  it("email and phone both present", () => {
    const m = contactsFromRows([A], [{ id: A, email: "a@example.test", phone: "+1 555 0100" }]);
    expect(m.kind === "ok" && m.byEntry.get(A)).toEqual({ kind: "entry", email: "a@example.test", phone: "+1 555 0100" });
  });
  it("phone missing, and email missing, are distinct null fields", () => {
    const m = contactsFromRows([A, B], [
      { id: A, email: "a@example.test", phone: null },
      { id: B, email: "  ", phone: "555 0101" },
    ]);
    if (m.kind !== "ok") throw new Error("unreachable");
    expect(m.byEntry.get(A)).toEqual({ kind: "entry", email: "a@example.test", phone: null });
    expect(m.byEntry.get(B)).toEqual({ kind: "entry", email: null, phone: "555 0101" });
  });
  it("two entries with the SAME name each keep their own contact (name is never read)", () => {
    const m = contactsFromRows([A, B], [
      { id: A, name: "Sam Sample", email: "first@example.test", phone: null },
      { id: B, name: "Sam Sample", email: "second@example.test", phone: "555 0102" },
    ]);
    if (m.kind !== "ok") throw new Error("unreachable");
    expect(m.byEntry.get(A)).toMatchObject({ email: "first@example.test", phone: null });
    expect(m.byEntry.get(B)).toMatchObject({ email: "second@example.test", phone: "555 0102" });
  });
  it("an id with no row is GONE, and nothing is guessed from another row", () => {
    const m = contactsFromRows([A, C], [{ id: A, email: "a@example.test", phone: null }]);
    if (m.kind !== "ok") throw new Error("unreachable");
    expect(m.byEntry.get(C)).toEqual({ kind: "gone" });
  });
});

describe("link builders", () => {
  it("mailto carries only the address", () => {
    expect(mailtoHref("a@example.test")).toBe("mailto:a@example.test");
    expect(mailtoHref("a@example.test?subject=x&body=y")).not.toContain("?subject");
  });
  it("tel keeps digits and a leading plus only, and is null when nothing is dialable", () => {
    expect(telHref("+1 (555) 010-0100")).toBe("tel:+15550100100");
    expect(telHref("ext. none")).toBeNull();
    expect(telHref("1+2")).toBe("tel:12");
  });
});

describe("source guards", () => {
  const LIB = read("lib/waitlist/reply-contact.ts")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n"); // code only: the header comment may say what it does NOT do
  const PAGE = read("app/(app)/settings/waitlist/replies/page.tsx");
  it("reads through the owner's own session, never the service role, and never writes", () => {
    expect(LIB).toContain('from "@/lib/supabase/server"');
    expect(LIB).not.toMatch(/admin-server|createAdminClient|service/i);
    expect(LIB).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    expect(LIB).not.toMatch(/console\.|logger/);
    expect(LIB).toContain('.eq("studio_id", studioId)');
    expect(LIB).toContain('.in("id"');
    expect(LIB).not.toMatch(/\.(eq|ilike|like)\("name"/);
  });
  it("the page checks the owner BEFORE it reads contact, and joins on entryId", () => {
    expect(PAGE.indexOf('practitioner.role !== "owner"')).toBeLessThan(PAGE.indexOf("loadReplyContacts("));
    expect(PAGE).toContain("r.entryId");
    expect(PAGE).not.toMatch(/entryName\s*===|\.name\s*===/);
  });
  it("the contact component has no form, action or server call: opening or copying changes nothing", () => {
    const C = read("components/waitlist/reply-contact.tsx");
    expect(C).not.toMatch(/<form|action=|"use server"|fetch\(|acknowledge/);
  });
});

describe("client/server split (the build broke when a client component reached next/headers)", () => {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(name)) files.push(rel);
    }
  };
  for (const d of ["app", "components", "lib"]) walk(d);
  it("no 'use client' file imports a server-only module", () => {
    const SERVER = /from\s+["'](@\/lib\/supabase\/(server|admin-server)|@\/lib\/waitlist\/reply-contact|server-only)["']/;
    const bad = files.filter((f) => {
      const src = read(f);
      return /^\s*["']use client["']/.test(src) && SERVER.test(src);
    });
    expect(bad).toEqual([]);
  });
  it("the server loader is server-only and the pure module imports nothing from the server", () => {
    expect(read("lib/waitlist/reply-contact.ts")).toContain('import "server-only"');
    expect(read("lib/waitlist/reply-contact-pure.ts")).not.toMatch(/^import /m);
  });
  it("the contact component imports only the pure module", () => {
    const c = read("components/waitlist/reply-contact.tsx");
    expect(c).toContain("@/lib/waitlist/reply-contact-pure");
    expect(c).not.toMatch(/@\/lib\/waitlist\/reply-contact["']/);
  });
});
