import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect, vi } from "vitest";
vi.mock("@/components/pending-link", () => ({ PendingLink: ({ href, children }: { href: string; children: unknown }) => createElement("a", { href }, children as never) }));
vi.mock("@/components/pending-button", () => ({ PendingButton: () => null }));
vi.mock("@/components/formatted-date-time", () => ({ FormattedDateTime: () => null }));
vi.mock("@/app/(app)/clients/[id]/actions", () => ({ unarchiveClientAction: async () => {} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
vi.mock("@/app/(app)/clients/group-actions", () => ({ changeClientGroup: async () => ({ ok: true }) }));
import { DirectoryResults } from "@/app/(app)/clients/ClientsDirectory";
import { ClientGroupsCard, GroupCatalogue } from "@/app/(app)/clients/ClientGroups";
import { queryDirectory, parseDirectoryParams } from "@/lib/clients/directory-query";
import { projectStaffRow } from "@/lib/clients/directory-rules";
const state = { view: "active" as const, q: "", filters: [], sort: "name" as const, lastVisit: "any" as const, page: 1, group: "group-id" };
const empty = queryDirectory([], { nextAppointments: new Map(), intake: new Map() }, parseDirectoryParams({}));
const group = { id: "group-id", name: "<Follow up>", updated_at: "2030-01-01T00:00:00Z" };
describe("client groups render in existing directory and profile", () => {
  it("unknown selected filter is explicit, with remove link preserving search", () => {
    const html = renderToStaticMarkup(createElement(DirectoryResults, { state: { ...state, q: "Jane" }, data: empty, groupBlocked: true, lastVisits: null, selectedId: null }));
    expect(html).toContain("couldn&#x27;t apply"); expect(html).toContain('href="/clients?q=Jane"'); expect(html).not.toContain("No clients yet");
  });
  it("valid empty group matches differs from a truly empty studio", () => {
    const html = renderToStaticMarkup(createElement(DirectoryResults, { state, data: { ...empty, directoryEmpty: false }, lastVisits: null, selectedId: null }));
    expect(html).toContain("No clients match"); expect(html).not.toContain("No clients yet");
    expect(renderToStaticMarkup(createElement(DirectoryResults, { state: { ...state, group: undefined }, data: empty, lastVisits: null, selectedId: null }))).toContain("No clients yet");
  });
  it("row chips escape names and preserve group on overview links", () => {
    const rows = [projectStaffRow({ id: "c1", name: "Client", preferred_name: null, pronouns: null, email: null, phone: null, archived_at: null })];
    const data = queryDirectory(rows, { nextAppointments: new Map(), intake: new Map() }, parseDirectoryParams({}));
    const html = renderToStaticMarkup(createElement(DirectoryResults, { state, data, lastVisits: null, selectedId: null, groups: { available: true, value: new Map([["c1", [group]]]) } }));
    expect(html).toContain("&lt;Follow up&gt;"); expect(html).toContain("client=c1&amp;group=group-id");
    const staff = renderToStaticMarkup(createElement(DirectoryResults, { state: { ...state, group: undefined }, data, lastVisits: null, selectedId: null }));
    expect(staff).not.toContain("Follow up"); expect(staff).not.toContain("Groups unavailable");
  });
  it("profile supports multiple independent removals and catalogue creation", () => {
    const html = renderToStaticMarkup(createElement(ClientGroupsCard, { clientId: "c1", catalogue: { available: true, value: [group] }, assigned: { available: true, value: [group] } }));
    expect(html).toContain("Remove &lt;Follow up&gt;"); expect(html).toContain("Manage groups"); expect(html).toContain("consent");
    const unavailable = renderToStaticMarkup(createElement(ClientGroupsCard, { clientId: "c1", catalogue: { available: false }, assigned: { available: false } }));
    expect(unavailable).toContain("unavailable"); expect(unavailable).not.toContain("No groups assigned");
    expect(renderToStaticMarkup(createElement(GroupCatalogue, { groups: [] }))).toContain("Create group");
    expect(renderToStaticMarkup(createElement(GroupCatalogue, { groups: [] }))).toContain("Group names are visible to owners only");
  });
});
