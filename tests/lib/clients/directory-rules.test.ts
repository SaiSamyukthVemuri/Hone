import { describe, expect, it } from "vitest";
import {
  isStaffRole,
  normalizeDirectoryRole,
  projectReceptionistRow,
  projectRowForRole,
  projectStaffRow,
  NAME_ON_FILE_LABEL,
  type DirectorySourceClient,
} from "@/lib/clients/directory-rules";

// Privacy S1 (one definition of what a row shows), S7 (role in, default deny).
const base = (over: Partial<DirectorySourceClient> = {}): DirectorySourceClient => ({
  id: "c1", name: "Stored Name", preferred_name: null, pronouns: "she/her",
  email: "a@example.test", phone: "+1 555 0100", archived_at: null, ...over,
});

describe("directory rules: what a row shows", () => {
  it("shows the preferred name when there is one, else the stored name as 'Name on file'", () => {
    expect(projectStaffRow(base({ preferred_name: "  Janie  " }))).toMatchObject({ displayName: "Janie", nameOnFile: false });
    expect(projectStaffRow(base())).toMatchObject({ displayName: "Stored Name", nameOnFile: true });
    expect(projectStaffRow(base({ preferred_name: "   " }))).toMatchObject({ displayName: "Stored Name", nameOnFile: true });
    expect(NAME_ON_FILE_LABEL).toBe("Name on file");
  });

  it("never carries the stored name beside a displayed preferred name, or any other source column", () => {
    const row = projectStaffRow(base({ preferred_name: "Janie", ...({ address: "SENTINEL", legal_given_name: "SENTINEL" } as object) }));
    expect(JSON.stringify(row)).not.toContain("Stored Name");
    expect(JSON.stringify(row)).not.toContain("SENTINEL");
    expect(Object.keys(row).sort()).toEqual(["archivedAt", "displayName", "email", "id", "nameOnFile", "phone", "pronouns"]);
  });
});

describe("directory rules: pronouns are staff-only (Privacy R-1)", () => {
  it("owners and practitioners keep pronouns; the receptionist projection and every unknown role drop them", () => {
    const c = base({ pronouns: "they/them", preferred_name: "Janie" });
    expect(projectStaffRow(c).pronouns).toBe("they/them");
    expect(projectRowForRole("owner", c).pronouns).toBe("they/them");
    expect(projectRowForRole("practitioner", c).pronouns).toBe("they/them");
    for (const role of ["receptionist", undefined, null, "", "admin", "OWNER"]) {
      expect(projectRowForRole(role, c).pronouns).toBeNull();
    }
    expect(projectReceptionistRow(c).pronouns).toBeNull();
    expect(JSON.stringify(projectReceptionistRow(c))).not.toContain("they/them");
    // Control: the rest of the permitted identity and contact is untouched.
    expect(projectReceptionistRow(c)).toMatchObject({ displayName: "Janie", email: c.email, phone: c.phone });
  });
});

describe("directory rules: roles default-deny (S7)", () => {
  it("owner and practitioner get the staff rules; the receptionist and every unknown role get the receptionist rules", () => {
    expect(normalizeDirectoryRole("owner")).toBe("owner");
    expect(normalizeDirectoryRole("practitioner")).toBe("practitioner");
    expect(normalizeDirectoryRole("receptionist")).toBe("receptionist");
    for (const bad of [undefined, null, "", "OWNER", "admin", 0, {}, "owner "]) {
      expect(normalizeDirectoryRole(bad)).toBe("receptionist");
      expect(isStaffRole(bad)).toBe(false);
    }
  });

  it("projects every role to the same permitted fields, and an unknown role through the receptionist function", () => {
    const c = base({ preferred_name: "Janie" });
    expect(projectRowForRole("owner", c)).toEqual(projectStaffRow(c));
    expect(projectRowForRole("practitioner", c)).toEqual(projectStaffRow(c));
    expect(projectRowForRole("receptionist", c)).toEqual(projectReceptionistRow(c));
    expect(projectRowForRole("who-knows", c)).toEqual(projectReceptionistRow(c));
    expect(projectRowForRole(undefined, c)).toEqual(projectReceptionistRow(c));
    // The receptionist fallback is the regular client name (Sam, 24 Nov, replacing the 2 Nov rule).
    expect(projectRowForRole(undefined, base())).toMatchObject({ displayName: "Stored Name", nameOnFile: false });
  });
});

describe("directory rules: the receptionist name rule (preferred, else regular, else Name on file only when both are blank)", () => {
  const LEGAL = "Zzlegal Identity Marker";
  const legalSource = (o: Partial<DirectorySourceClient>) => ({ ...base(o), legal_name: LEGAL, legal_identity: { given: LEGAL }, client_legal_identities: [{ legal_name: LEGAL }] }) as DirectorySourceClient;
  it("a preferred-name client whose regular name differs: the preferred name wins and the regular name is not in the row", () => {
    const row = projectReceptionistRow(base({ name: "Regular Name", preferred_name: "Janie" }));
    expect(row).toMatchObject({ displayName: "Janie", nameOnFile: false });
    expect(JSON.stringify(row)).not.toContain("Regular Name");
  });
  it("a regular-name-only client: the regular name is shown, and it is not labelled Name on file", () => {
    expect(projectReceptionistRow(base({ name: "Regular Name", preferred_name: null }))).toMatchObject({ displayName: "Regular Name", nameOnFile: false });
    expect(projectReceptionistRow(base({ name: "Regular Name" }))).toMatchObject({ displayName: "Regular Name", nameOnFile: false });
  });
  it("both blank (empty, null or whitespace): the literal Name on file", () => {
    for (const [name, preferred_name] of [["", null], ["   ", "  "], ["", ""], ["\t\n", "   "]] as const) {
      expect(projectReceptionistRow(base({ name, preferred_name }))).toMatchObject({ displayName: "Name on file", nameOnFile: true });
    }
  });
  it("a whitespace-only preferred name is blank: the regular name is shown", () => {
    expect(projectReceptionistRow(base({ name: "Regular Name", preferred_name: "   " }))).toMatchObject({ displayName: "Regular Name", nameOnFile: false });
  });
  it("the legal identity never appears in the row, whatever the source row carries", () => {
    for (const o of [{ preferred_name: "Janie" }, { preferred_name: null }, { name: "", preferred_name: null }]) {
      expect(JSON.stringify(projectReceptionistRow(legalSource(o)))).not.toContain(LEGAL);
      expect(JSON.stringify(projectRowForRole("receptionist", legalSource(o)))).not.toContain(LEGAL);
    }
  });
  it("staff rows are unchanged: the regular name is captioned Name on file", () => {
    expect(projectStaffRow(base({ name: "Regular Name", preferred_name: null }))).toMatchObject({ displayName: "Regular Name", nameOnFile: true });
  });
});
