import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

// Permanent source guard: the Supabase CLI's local workspace state under
// supabase/.temp/ must NEVER be tracked in Git.
//
// These files carry the LINKED project reference, supabase/.temp/project-ref,
// linked-project.json, and pooler-url all embed the project ref. They were once
// tracked with the PRODUCTION ref, so checking the repo out in a staging
// workspace silently overwrote the staging link with production. A pre-command
// guard caught it before a database command, but the durable fix is to keep this
// directory untracked (see .gitignore) and to fail CI if it is ever re-added.
//
// This inspects Git's TRACKED PATH SET (git ls-files), not merely .gitignore
// text, so a stray `git add -f supabase/.temp/...` is caught too.

const ROOT = path.resolve(__dirname, "../..");

function trackedUnder(pathspec: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", pathspec], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return out.split("\0").filter(Boolean);
}

describe("supabase/.temp must never be tracked in Git", () => {
  it("has zero tracked files anywhere beneath supabase/.temp/", () => {
    const tracked = trackedUnder("supabase/.temp");
    expect(
      tracked,
      `supabase/.temp is Git-tracked (project-ref leak / staging↔prod foot-gun); remove with \`git rm --cached\`: ${tracked.join(", ")}`,
    ).toEqual([]);
  });

  it("the linked-project reference files specifically are not tracked", () => {
    for (const f of [
      "supabase/.temp/project-ref",
      "supabase/.temp/linked-project.json",
      "supabase/.temp/pooler-url",
    ]) {
      expect(trackedUnder(f), `${f} must not be tracked`).toEqual([]);
    }
  });
});
