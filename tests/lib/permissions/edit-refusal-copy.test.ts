import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EDIT_RECORDS_REFUSAL, VIEW_REFUSAL } from "@/lib/permissions/refusal-copy";

// Read-only chart mode: a refusal of clin.edit_records must never reuse the "cannot see this" copy.
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : n.endsWith(".ts") ? [join(d, n)] : []));

describe("edit refusal copy", () => {
  it("is distinct from the view refusal and says the chart can be viewed", () => {
    expect(EDIT_RECORDS_REFUSAL).not.toBe(VIEW_REFUSAL);
    expect(EDIT_RECORDS_REFUSAL).toMatch(/view this chart/i);
  });
  it("every clin.edit_records gate in the clients actions answers with the edit copy, never the view copy", () => {
    const bad: string[] = [];
    let gates = 0;
    for (const f of walk("app/(app)/clients")) {
      const L = readFileSync(f, "utf8").split("\n");
      L.forEach((l, i) => {
        if (!/requirePermission\(.*"clin\.edit_records"/.test(l)) return;
        gates++;
        const win = L.slice(i, i + 4).join("\n");
        // startSessionAction is a form action: it answers a refusal with a redirect to the new-session page, which renders EDIT_RECORDS_REFUSAL (a throw would land on the error boundary).
        const handled = f.endsWith("sessions/new/actions.ts") && /redirect\(`\/clients\/\$\{clientId\}\/sessions\/new`\)/.test(win);
        if (!win.includes("editRecordsRefusal(editDecision)") && !win.includes("EDIT_RECORDS_REFUSAL") && !handled) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(gates).toBeGreaterThan(15);
    expect(bad).toEqual([]);
  });
});
