import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildClientFormData } from "@/lib/clients/client-form-payload";

// HON-58 slice 2, the form half. The repo has no DOM test environment, so the
// submit payload is a pure function tested here, and the ClientForm wiring
// around it is pinned by source. The server rule is behaviour-tested in
// tests/app/clients/new-client-duplicate-warning.test.ts.

describe("ClientForm submit payload", () => {
  it("an ordinary save sends the values and hidden fields, and no confirmation", () => {
    const fd = buildClientFormData({ name: "Jane", phone: "604" }, { client_id: "c1" });
    expect(Object.fromEntries(fd)).toEqual({ name: "Jane", phone: "604", client_id: "c1" });
    expect(fd.has("confirm_possible_duplicate")).toBe(false);
  });

  it("'save anyway' confirms exactly the warned client", () => {
    const fd = buildClientFormData({ name: "Jane" }, undefined, "client-jane");
    expect(fd.getAll("confirm_possible_duplicate")).toEqual(["client-jane"]);
  });

  it("an empty confirmation is never sent", () => {
    expect(buildClientFormData({ name: "Jane" }, undefined, "").has("confirm_possible_duplicate")).toBe(false);
    expect(buildClientFormData({ name: "Jane" }, undefined, null).has("confirm_possible_duplicate")).toBe(false);
  });
});

describe("ClientForm wiring (source pins)", () => {
  const form = readFileSync("components/client-form.tsx", "utf8");

  it("submits through the payload builder", () => {
    expect(form).toContain("buildClientFormData(values, hiddenFields, confirmPossibleDuplicateId)");
  });

  it("the ordinary submit never confirms; only the warning's button does, for the warned client", () => {
    expect(form).toMatch(/function handleSubmit[\s\S]*?submit\(null\);/);
    expect(form).toContain("onClick={() => submit(possibleDuplicate.clientId)}");
    expect(form).toContain("Save as a new client anyway");
  });

  it("any field edit withdraws the warning, so a changed form is checked again", () => {
    const update = form.slice(form.indexOf("function update<"), form.indexOf("function submit("));
    expect(update).toContain("setPossibleDuplicate(undefined);");
  });
});
