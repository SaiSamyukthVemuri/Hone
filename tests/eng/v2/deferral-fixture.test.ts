import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// SHEP-LATEST-01 PR2. Pins the REAL jobs-API listing of a draft deferral, so the reader
// work of PR3 is written against what GitHub returned, not an invented shape. These
// tests assert the FIXTURE, not any shepherd behaviour.

const DIR = path.resolve(__dirname, "fixtures/ci-deferral");
const read = (f: string) => readFileSync(path.join(DIR, f));
const JOBS = JSON.parse(read("draft-run-43459049109-jobs.json").toString("utf8"));
const RUN = JSON.parse(read("draft-run-43459049109.json").toString("utf8"));
const HEAD = "c1e77f71a8b0965f06ffe7b76684473c0f615619";

describe("real draft-deferral fixture (#1441, run 43459049109)", () => {
  it("is byte-identical to its recorded digests", () => {
    for (const line of read("SHA256SUMS").toString("utf8").trim().split("\n")) {
      const [sum, file] = line.split(/\s+/);
      expect(createHash("sha256").update(read(file)).digest("hex"), file).toBe(sum);
    }
  });
  it("is a pull_request run at the recorded head, completed with failure", () => {
    expect(RUN.id).toBe(43459049109);
    expect(RUN.event).toBe("pull_request");
    expect(RUN.head_sha).toBe(HEAD);
    expect([RUN.status, RUN.conclusion]).toEqual(["completed", "failure"]);
    expect(RUN.run_attempt).toBe(1);
    expect(Array.isArray(RUN.pull_requests)).toBe(true);
    expect(RUN.pull_requests.map((p: { number: number }) => p.number)).toEqual([1441]);
  });
  it("lists one aggregator job whose steps are exactly the real runner sequence", () => {
    const agg = JOBS.jobs.filter((j: { name: string }) => j.name === "browser e2e (local stack)");
    expect(agg).toHaveLength(1);
    expect(agg[0].run_id).toBe(43459049109);
    expect(agg[0].steps.map((s: { number: number; name: string; conclusion: string }) => [s.number, s.name, s.conclusion])).toEqual([
      [1, "Set up job", "success"],
      [2, "Fail closed on prerequisites", "success"],
      [3, "DRAFT-DEFERRED", "failure"],
      [4, "Aggregate browser shard results", "skipped"],
      [5, "Complete job", "success"],
    ]);
    expect(agg[0].conclusion).toBe("failure");
  });
  it("every other job is success or skipped; the gate passed; heavy lanes were skipped", () => {
    const others = JOBS.jobs.filter((j: { name: string }) => j.name !== "browser e2e (local stack)");
    expect(others.length).toBeGreaterThan(5);
    for (const j of others) expect(["success", "skipped"], j.name).toContain(j.conclusion);
    const byName = (n: string) => JOBS.jobs.find((j: { name: string }) => j.name === n);
    expect(byName("changed-path detection").conclusion).toBe("success");
    expect(byName("db integration (local supabase)").conclusion).toBe("skipped");
    // a skipped matrix job keeps its UNRENDERED name and has no steps
    const shard = JOBS.jobs.find((j: { name: string }) => j.name.startsWith("browser shard ${{ matrix.shard }}"));
    expect(shard.conclusion).toBe("skipped");
    expect(shard.steps).toEqual([]);
  });
  it("the listing is complete in one response", () => {
    expect(JOBS.total_count).toBe(JOBS.jobs.length);
  });
});
