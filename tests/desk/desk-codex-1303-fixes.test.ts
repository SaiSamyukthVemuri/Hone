import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Codex review fixes on #1303: studio-clock times in the directory; row actions reset after a move.
const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");

describe("desk directory times use the studio clock", () => {
  const dir = read("app/(desk)/desk/clients/DeskDirectory.tsx");
  it("formats with the studio timezone, never the browser's", () => {
    expect(dir).toContain("formatStudioDateTime(row.nextAppointmentAt, timezone)");
    expect(dir).not.toContain("FormattedDateTime");
  });
  it("the page and the search action both supply the studio timezone", () => {
    expect(read("app/(desk)/desk/clients/page.tsx")).toContain("readStudioTimezone(");
    expect(read("app/(desk)/desk/clients/actions.ts")).toContain("readStudioTimezone(");
  });
});

describe("schedule row actions remount when the interval changes", () => {
  it("the key includes start, end and practitioner so a moved row is offered actions again", () => {
    expect(read("app/(desk)/desk/page.tsx")).toContain("key={`${r.appointmentId}:${r.startsAt}:${r.endsAt}:${r.practitionerId ?? \"\"}`}");
  });
});
