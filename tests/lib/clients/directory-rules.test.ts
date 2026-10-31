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
    // The receptionist fallback is the stored name, labelled.
    expect(projectRowForRole(undefined, base())).toMatchObject({ displayName: "Stored Name", nameOnFile: true });
  });
});
