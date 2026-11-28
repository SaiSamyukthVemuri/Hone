import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminQuery, asUser, closePool, seedMember, seedStudio, type SeededStudio } from "./helpers/harness";
import { defaultPortalPresentation } from "@/lib/portal/presentation";

const draft = defaultPortalPresentation();
const changed = { ...draft, welcomeHeading: "Welcome, {client}." };
const command = "public.edit_studio_portal_presentation(uuid,integer,text,jsonb)";
let studio: SeededStudio;
let other: SeededStudio;
let member: { userId: string };

function edit(user: string, revision: number, op: string, copy: unknown = null) {
  return asUser(user, q => q("select public.edit_studio_portal_presentation($1, $2, $3, $4)", [
    studio.studioId, revision, op, copy === null ? null : JSON.stringify(copy),
  ]));
}
function read(user: string) {
  return asUser(user, q => q("select revision,draft,published from public.studio_portal_presentations where studio_id=$1", [studio.studioId]));
}
beforeAll(async () => {
  studio = await seedStudio("portal-presentation", { verifiedPaymentJurisdiction: false });
  other = await seedStudio("other-portal", { verifiedPaymentJurisdiction: false });
  member = await seedMember(studio, "editor-member");
});
afterAll(closePool);

describe("studio portal presentation authority and publication", () => {
  it("blocks anonymous commands, direct owner writes and all service reads of draft copy", async () => {
    const { rows } = await adminQuery(`select
      has_function_privilege('anon', $1, 'execute') as anon_exec,
      has_function_privilege('authenticated', $1, 'execute') as owner_exec,
      has_function_privilege('service_role', $1, 'execute') as service_exec,
      has_column_privilege('service_role','public.studio_portal_presentations','draft','select') as draft,
      has_column_privilege('service_role','public.studio_portal_presentations','published','select') as published,
      has_column_privilege('anon','public.studio_portal_presentations','published','select') as anon_read`, [command]);
    expect(rows[0]).toEqual({ anon_exec: false, owner_exec: true, service_exec: false, draft: false, published: true, anon_read: false });
    for (const directWrite of [
      "insert into public.studio_portal_presentations (studio_id,revision,draft) values ($1,1,'{}')",
      "update public.studio_portal_presentations set published=draft where studio_id=$1",
      "delete from public.studio_portal_presentations where studio_id=$1",
    ]) {
      await expect(asUser(studio.userId, q => q(directWrite, [studio.studioId]))).rejects.toMatchObject({ code: "42501" });
    }
  });
  it("serializes first save, separates publish/draft, refuses stale changes and restores classic without losing draft", async () => {
    expect((await read(studio.userId)).rows).toEqual([]);
    for (const user of [member.userId, other.userId]) {
      await expect(edit(user, 0, "save", draft)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(edit(studio.userId, 0, "save", { ...draft, sections: draft.sections.map(() => draft.sections[0]) }))
      .rejects.toMatchObject({ code: "22023" });
    const sameRevision = await Promise.allSettled([edit(studio.userId, 0, "save", draft), edit(studio.userId, 0, "save", draft)]);
    expect(sameRevision.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(sameRevision.find(result => result.status === "rejected")).toMatchObject({reason: {code: "40001"}});
    expect((await read(studio.userId)).rows[0]).toEqual({ revision: 1, draft, published: null });
    await edit(studio.userId, 1, "publish");
    await edit(studio.userId, 2, "save", changed);
    expect((await read(studio.userId)).rows[0]).toEqual({ revision: 3, draft: changed, published: draft });
    await expect(edit(studio.userId, 2, "publish")).rejects.toMatchObject({ code: "40001" });
    for (const user of [member.userId, other.userId]) {
      expect((await read(user)).rows).toEqual([]);
      await expect(edit(user, 3, "classic")).rejects.toMatchObject({ code: "42501" });
    }
    await edit(studio.userId, 3, "classic");
    expect((await read(studio.userId)).rows[0]).toEqual({ revision: 4, draft: changed, published: null });
    await edit(studio.userId, 4, "publish");
    expect((await read(studio.userId)).rows[0]).toEqual({ revision: 5, draft: changed, published: changed });
  });
});
