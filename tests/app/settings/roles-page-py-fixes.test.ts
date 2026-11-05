import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_ERROR_CODES } from "@/lib/settings/roles/api";
import { roleErrorMessage } from "@/lib/settings/roles/api";

// Insurance PEER-1335 3888b802a: PY-2 .. PY-6. Source pins: the editor is a client component with no DOM harness in this repo, so the
// behaviour is pinned where it is written.
const editor = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
const model = readFileSync("lib/settings/roles/model.ts", "utf8");
const fn = (name: string) => {
  const i = editor.indexOf(name);
  return editor.slice(i, editor.indexOf("\n  }\n", i));
};

describe("PY-2 no blanket or forbidden promises", () => {
  it("the next-request line is qualified to enforced settings", () => {
    expect(editor).toContain("only for settings the app already enforces");
    expect(editor).not.toMatch(/Changes apply to each person&rsquo;s next request, including people who are signed in now\./);
  });
  it("the not-enforced line no longer promises the switch will apply when the area is wired", () => {
    expect(model).not.toContain("will apply when that area is wired");
    expect(model).toContain("will not switch on by itself");
  });
});

describe("PY-3 the review is sequenced and Save sends what was previewed", () => {
  it("onReview ignores a late response; Save uses the previewed edits", () => {
    expect(fn("async function onReview")).toMatch(/seq !== reviewSeq\.current\) return/);
    expect(fn("async function onSave")).toContain("props.save(reviewedEdits.current,");
    expect(fn("async function onSave")).not.toContain("changedEdits()");
  });
  it("any new choice or discard invalidates a pending review", () => {
    expect(fn("function choose")).toContain("reviewSeq.current += 1");
    expect(fn("function discard")).toContain("reviewSeq.current += 1");
  });
});

describe("PY-4 reset and adopt never drop unsaved choices silently", () => {
  it("openPreview refuses while dirty, before asking the core", () => {
    const body = fn("async function openPreview");
    expect(body.indexOf("if (dirty)")).toBeGreaterThan(-1);
    expect(body.indexOf("if (dirty)")).toBeLessThan(body.indexOf("props.previewAdopt"));
  });
});

describe("PY-6 'unexpected' does not claim nothing changed", () => {
  it("the message says the result could not be confirmed", () => {
    expect(roleErrorMessage({ code: "unexpected" })).not.toMatch(/Nothing was changed/);
    expect(roleErrorMessage({ code: "unexpected" })).toMatch(/could not confirm/);
  });
  it("save, reset and adopt read the policy back on 'unexpected' and compare versions", () => {
    expect(fn("async function onSave")).toContain("resolveUnexpected(boundVersion, reviewedEdits.current)");
    expect(fn("async function confirmPreview")).toContain("resolveUnexpected(boundVersion, null)");
    const body = fn("async function resolveUnexpected");
    expect(body).toContain("props.reload()");
    expect(body).toContain("classifyUnexpected(");
    expect(body).not.toContain("fresh.state.version === boundVersion");
    expect(body).toContain("UNCERTAIN_SAVE_MESSAGE");
  });
});

it("the page knows every code the core returns", () => {
  for (const c of ["keys_required", "preview_required", "stale_preview", "not_released"]) expect(ROLE_ERROR_CODES as readonly string[]).toContain(c);
});

describe("Codex P2 4476375641: a reset or adoption preview does not outlive an edit", () => {
  it("every edit drops the preview first, so a late response is ignored too", () => {
    const drop = fn("function dropPreview");
    expect(drop).toContain("previewSeq.current += 1;");
    expect(drop).toContain("setPreview(null);");
    expect(drop).toContain("setPreviewConfirmed(false);");
    // The two places that stage an edit into the draft each drop it before writing the draft.
    for (const m of editor.matchAll(/dropPreview\(\);\n\s+setDrafts\(\(d\) => \(\{ \.\.\.d, \[(role|forRole)\]: result\.policy \}\)\);/g)) expect(m[0]).toBeTruthy();
    expect([...editor.matchAll(/dropPreview\(\);\n\s+setDrafts\(\(d\) => \(\{ \.\.\.d, \[(role|forRole)\]: result\.policy \}\)\);/g)]).toHaveLength(2);
  });
  it("confirm refuses while the draft is dirty, before calling the core", () => {
    const body = fn("async function confirmPreview");
    expect(body.indexOf("if (dirty)")).toBeGreaterThan(-1);
    expect(body.indexOf("if (dirty)")).toBeLessThan(body.indexOf("props.adopt("));
    expect(body.indexOf("if (dirty)")).toBeLessThan(body.indexOf("props.reset("));
  });
  it("the confirm button is not enabled while the draft is dirty", () => {
    expect(editor).toContain("canConfirm={props.writable && !dirty && reasonAcceptable(preview.kind, false, reason)");
  });
});
