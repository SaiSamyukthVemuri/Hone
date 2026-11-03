import { describe, expect, it } from "vitest";
import { describeContactChanges, maskEmail, maskPhone, maskPreferredName } from "@/lib/clients/contact-audit";

describe("contact audit masks (R5, prepared)", () => {
  it("email keeps the first letter and the domain suffix only", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j•••@e•••.com");
    expect(maskEmail("a@b.co.uk")).toBe("a•••@b•••.uk");
    expect(maskEmail("not-an-email")).toBe("n•••");
    expect(maskEmail("")).toBe("(empty)");
    expect(maskEmail(null)).toBe("(empty)");
  });
  it("phone keeps the last four digits only", () => {
    expect(maskPhone("604-555-0123")).toBe("•••• 0123");
    expect(maskPhone("+1 (604) 555 0123")).toBe("•••• 0123");
    expect(maskPhone("12")).toBe("••••");
    expect(maskPhone(null)).toBe("(empty)");
  });
  it("preferred name keeps the first character and the length, by code point", () => {
    expect(maskPreferredName("Jo")).toBe("J••• (2)");
    expect(maskPreferredName("😀ab")).toBe("😀••• (3)");
    expect(maskPreferredName("  ")).toBe("(empty)");
  });
  it("no mask contains the full original value", () => {
    const e = "jane.doe@example.com", p = "604-555-0123", n = "Jane";
    for (const [m, v] of [[maskEmail(e), e], [maskPhone(p), p], [maskPreferredName(n), n]] as const) expect(m).not.toContain(v);
    expect(maskEmail(e)).not.toContain("jane");
    expect(maskPhone(p)).not.toContain("604");
  });
  it("describes only the fields that changed, masked; formatting-only phone change counts, email case does not", () => {
    const before = { email: "Jane@Example.com", phone: "604-555-0123", preferred_name: null };
    expect(describeContactChanges(before, { ...before, email: "jane@example.com" })).toEqual([]);
    expect(describeContactChanges(before, { ...before, phone: "6045550123" })).toEqual([{ field: "phone", from: "•••• 0123", to: "•••• 0123" }]);
    expect(describeContactChanges(before, { email: "new@other.org", phone: "604-555-0123", preferred_name: "Jay" })).toEqual([
      { field: "email", from: "J•••@E•••.com", to: "n•••@o•••.org" },
      { field: "preferred_name", from: "(empty)", to: "J••• (3)" },
    ]);
  });
});
