<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

OpenWiki is currently updated on demand: an operator or agent runs an OpenWiki `update` (MCP tools or CLI) and commits the result. A scheduled refresh workflow is not installed in this repository yet. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and then running an OpenWiki update.

<!-- OPENWIKI:END -->

<!-- Maintained outside the OpenWiki-managed block above, so OpenWiki preserves it. -->
**Known OpenWiki 0.6.1 defect.** OpenWiki rewrites everything between the `OPENWIKI:START`/`OPENWIKI:END`
markers from a static template on every run: `openwiki_begin` (init and update) and every CLI code-mode run.
That template (`dist/ingestion/code-mode.js`, `createCodeModeAgentsSnippet`) hard-codes the sentence "The
scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki." That sentence is false here. No
OpenWiki workflow is installed, and the one OpenWiki generates at init was deliberately not committed. After
any OpenWiki run, restore the on-demand wording above before committing, until the upstream template is fixed.
