export type WorkspaceView = "waiting" | "invited" | "responses" | "history";

export function workspaceView({
  section, tab, view, followup, fu,
}: Record<string, string | undefined>): WorkspaceView {
  if (view === "declined" || followup === "1" || ["done", "already", "refused", "failed"].includes(fu ?? "")) return "responses";
  if (section === "invited") return "invited";
  if (section === "released" || section === "expired") return "history";
  if (section === "waiting" || section === "claimed") return "waiting";
  return tab === "responses" || tab === "history" ? tab : "waiting";
}
