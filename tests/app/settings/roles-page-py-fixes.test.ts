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
    expect(editor).toContain("Once activated, a saved change applies");
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
    expect(body).toContain("readBack()"); // wraps props.reload() (B-2)
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

// Codex P2 4477378035: edits made while a save or its read-back is in flight were silently replaced by the saved policy.
describe("editing is disabled while a save, reset, adopt or read-back is in flight", () => {
  const SRC = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("the busy window is the whole 'saving' feedback state and turns every row read-only", () => {
    expect(SRC).toContain('const busy = feedback.state.kind === "saving" || refreshing || activating;');
    expect(SRC).toContain("const readOnly = !props.writable || busy;");
  });
  it("the edit entry points refuse while busy", () => {
    for (const fn of ["function choose(", "function stageBasisChoice(", "function discard(", "async function openPreview("]) {
      const at = SRC.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      expect(SRC.slice(at, SRC.indexOf("\n", SRC.indexOf("\n", at) + 1))).toContain("if (busy) return;");
    }
  });
  it("the saving state outlasts the read-back (it ends only at feedback.saved/failed after reload)", () => {
    const save = SRC.slice(SRC.indexOf("async function onSave()"), SRC.indexOf("async function resolveUnexpected"));
    expect(save.indexOf("feedback.saving()")).toBeLessThan(save.indexOf("readBack()"));
    expect(save.indexOf("readBack()")).toBeLessThan(save.indexOf("feedback.saved()"));
  });
});

// Insurance/Privacy B-1, B-2 on #1335.
describe("the busy window outlasts the refresh and a rejected promise ends it", () => {
  const SRC = readFileSync("app/(app)/settings/roles/roles-editor.tsx", "utf8");
  it("B-1: router.refresh runs inside a transition and busy includes it (refresh() returns void, so awaiting it would hold nothing)", () => {
    expect(SRC).toContain("const [refreshing, startRefresh] = useTransition();");
    expect(SRC).toContain("const refreshNow = () => startRefresh(() => router.refresh());");
    expect(SRC).toContain('const busy = feedback.state.kind === "saving" || refreshing || activating;');
    // the reset/adopt, the reload-failure and the activation paths all go through it; the people panel's own refresh is unrelated to the draft
    expect(SRC.match(/router\.refresh\(\)/g)?.length).toBe(3); // refreshNow + the People panel + a comment
  });
  it("B-2: save, reload, reset and adopt are each guarded, so a rejection reaches a visible error", () => {
    expect(SRC).toContain("return await props.reload();");
    expect(SRC).toMatch(/result = await props\.save\([^;]*;\s*\} catch \{[\s\S]{0,200}resolveUnexpected\(boundVersion, reviewedEdits\.current\)/);
    expect(SRC).toMatch(/await props\.adopt\([^]*?\} catch \{\s*await resolveUnexpected\(boundVersion, null\)/);
    expect(SRC.match(/feedback\.failed\(LOST_MESSAGE\)/g)?.length).toBe(2);
  });
});
