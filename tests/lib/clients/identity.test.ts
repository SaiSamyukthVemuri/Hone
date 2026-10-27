import { describe, expect, it } from "vitest";
import {
  clinicalPacketName,
  insurerDocumentName,
  clientClinicalName,
  clientCommunicationName,
  clientDisplayName,
  clientIdentityPair,
  clientLegalName,
} from "@/lib/clients/identity";
import { matchesClientSearch } from "@/lib/clients/name-search";

// HON-58 — one client identity, two names. Every name below is SYNTHETIC.

const BOTH = {
  name: "Jane Smith",
  preferred_name: "Janie",
  legal_given_name: "Jane",
  legal_middle_name: "Marie",
  legal_family_name: "Smith-Reyes",
};

describe("display name: preferred when given, else the stored name", () => {
  it("uses the preferred name on ordinary surfaces", () => {
    expect(clientDisplayName(BOTH)).toBe("Janie");
    expect(clientCommunicationName(BOTH)).toBe("Janie");
  });

  it.each([
    ["no preferred name", { name: "Jane Smith" }],
    ["null preferred name", { name: "Jane Smith", preferred_name: null }],
    ["empty preferred name", { name: "Jane Smith", preferred_name: "" }],
    ["blank preferred name", { name: "Jane Smith", preferred_name: "   " }],
  ])("falls back to the stored name: %s", (_label, client) => {
    expect(clientDisplayName(client)).toBe("Jane Smith");
  });

  it("collapses stray spacing and never returns a legal name", () => {
    expect(clientDisplayName({ name: "  Jane   Smith ", preferred_name: null })).toBe("Jane Smith");
    expect(clientDisplayName({ name: "Jane Smith", legal_given_name: "Janet" })).toBe("Jane Smith");
  });

  it("is an empty string, not a crash, for a record with no name at all", () => {
    expect(clientDisplayName({})).toBe("");
  });
});

describe("legal / clinical name: the legal identity when set, else the stored name", () => {
  it("joins given, middle and family in order and skips a missing part", () => {
    expect(clientLegalName(BOTH)).toBe("Jane Marie Smith-Reyes");
    expect(clientLegalName({ legal_given_name: "Jane", legal_family_name: "Smith" })).toBe("Jane Smith");
    expect(clientLegalName({ legal_family_name: "Smith" })).toBe("Smith");
  });

  it("is null when no legal identity is set (never inferred from name or preferred name)", () => {
    expect(clientLegalName({ name: "Jane Smith", preferred_name: "Janie" })).toBeNull();
    expect(clientLegalName({ legal_given_name: "  ", legal_family_name: null })).toBeNull();
  });

  it("clinical and insurer output uses the legal identity, never the preferred name alone", () => {
    expect(clientClinicalName(BOTH)).toBe("Jane Marie Smith-Reyes");
    expect(clientClinicalName({ name: "Jane Smith", preferred_name: "Janie" })).toBe("Jane Smith");
  });

  it("an existing record with none of the new fields prints exactly as before", () => {
    const legacy = { name: "Jane (Janie) Smith" };
    expect(clientDisplayName(legacy)).toBe("Jane (Janie) Smith");
    expect(clientClinicalName(legacy)).toBe("Jane (Janie) Smith");
    expect(clientCommunicationName(legacy)).toBe("Jane (Janie) Smith");
  });
});

describe("authorized pair view", () => {
  it("shows the legal name only when it differs from the display name", () => {
    expect(clientIdentityPair(BOTH)).toEqual({ display: "Janie", legal: "Jane Marie Smith-Reyes" });
    expect(clientIdentityPair({ name: "Jane Smith", legal_given_name: "Jane", legal_family_name: "Smith" })).toEqual({
      display: "Jane Smith",
      legal: null,
    });
    expect(clientIdentityPair({ name: "Jane Smith" })).toEqual({ display: "Jane Smith", legal: null });
  });
});

describe("one record found through either name (no second client)", () => {
  const record = { ...BOTH, email: "jane.s@example.test", phone: "(555) 010-0001" };

  it.each([
    ["preferred name", "janie"],
    ["preferred name + surname", "Janie Smith"],
    ["legal given name + surname", "JANE   smith"],
    ["legal family name alone", "reyes"],
    ["legal family name, punctuation variation", "smith reyes"],
    ["surname first", "smith, jane"],
    ["legal middle name", "marie"],
  ])("finds the record by %s (%s)", (_label, query) => {
    expect(matchesClientSearch(record, query)).toBe(true);
  });

  it("does not find it by a name it does not have", () => {
    expect(matchesClientSearch(record, "janet")).toBe(false);
    expect(matchesClientSearch(record, "dana reyes")).toBe(false);
  });

  it("with only the stored name set, behaves exactly as before", () => {
    const legacy = { name: "Jane (Janie) Smith", email: null, phone: null };
    expect(matchesClientSearch(legacy, "janie smith")).toBe(true);
    expect(matchesClientSearch(legacy, "reyes")).toBe(false);
  });

  it("a surface that did not select the legal parts cannot find a record by them", () => {
    const withoutLegal = { name: "Jane Smith", preferred_name: "Janie" };
    expect(matchesClientSearch(withoutLegal, "janie")).toBe(true);
    expect(matchesClientSearch(withoutLegal, "reyes")).toBe(false);
  });
});

describe("no name field is logged or leaked by the module", () => {
  it("is a pure function of its input: no console call, no network, no module state", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/clients/identity.ts", "utf8");
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/process\.env/);
  });
});

describe("document identity (OPS Q2): insurer legal only, internal clinical packet legal + (preferred)", () => {
  it("an insurer or claim document prints the legal identity and never the preferred name", () => {
    expect(insurerDocumentName(BOTH)).toBe("Jane Marie Smith-Reyes");
    expect(insurerDocumentName(BOTH)).not.toContain("Janie");
    expect(insurerDocumentName({ name: "Jane Smith", preferred_name: "Janie" })).toBe("Jane Smith");
  });

  it("an internal clinical packet prints the legal identity with the preferred name in parentheses", () => {
    expect(clinicalPacketName(BOTH)).toBe("Jane Marie Smith-Reyes (Janie)");
    expect(clinicalPacketName({ name: "Jane Smith", preferred_name: "Janie" })).toBe("Jane Smith (Janie)");
  });

  it("does not repeat a preferred name that equals the legal name, or add one that is absent", () => {
    expect(clinicalPacketName({ name: "Jane Smith", preferred_name: "jane smith" })).toBe("Jane Smith");
    expect(clinicalPacketName({ name: "Jane Smith" })).toBe("Jane Smith");
    expect(clinicalPacketName({ name: "Jane Smith", preferred_name: "  " })).toBe("Jane Smith");
  });
});
