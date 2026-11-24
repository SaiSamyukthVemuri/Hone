# Hone development with pstack

Use pstack for all Hone development tasks, including investigations, bug fixes,
features, refactoring, UI work, tests, and PR preparation. Choose the matching
playbook and load its supporting skills when needed. A small edit stays small.

## Source

The Claude Code marketplace is pinned in `.claude/settings.json` to
`cursor/plugins` commit `7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9`, which ships
pstack **0.15.46**. Automatic marketplace updates are off. Change that pin in a
reviewed PR after checking the upstream diff and adapter. No upstream source is
copied or modified in Hone.

Read these upstream files at that commit:

- [Entry point](https://github.com/cursor/plugins/blob/7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9/pstack/skills/poteto-mode/SKILL.md)
- [Claude Code adapter](https://github.com/cursor/plugins/blob/7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9/pstack/docs/harness/claude-code.md)
- [Plugin manifest](https://github.com/cursor/plugins/blob/7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9/pstack/plugin.json)
- [Installation reference](https://github.com/cursor/plugins/blob/7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9/pstack/README.md)

## Load at task start

1. Read this document once per session. Follow `ENGINEERING_STANDARDS.md`,
   `DESIGN.md`, `CLAUDE.md`, and `CONTRIBUTING.md` where applicable.
2. Locate the installed pstack entry point and read it in full. In Claude Code,
   also read its bundled `docs/harness/claude-code.md`. Use the installed local
   files and their relative links when the installation matches the pin.
3. If the plugin is unavailable, read the pinned entry point through the GitHub
   connector or another available repository reader. Resolve its playbooks and
   supporting skill links at the same commit. Do not substitute an unreviewed
   `main` revision. If fetching is unavailable, report that pstack could not be
   loaded and continue independent work under Hone's existing standards.
4. Select the smallest matching playbook and read the skills it calls for as
   needed. Do not preload the entire plugin. Keep one task owner and one
   verification path. Reuse existing work and exact-head evidence.

Loading and following the entry point is the default. A slash command is a
convenience, not a requirement the operator must repeat. Do not claim native
plugin installation merely because these instructions were loaded.

## Hone adaptations

Hone's repository rules and the operator's current instructions govern conflicts
with upstream defaults. Apply these adaptations before executing a playbook:

- **Risk and speed.** Use `npm run ci:plan -- --json` and semantic judgment.
  Preserve the required lanes. Trivial copy or documentation work does not need
  competing designs, a model panel, formal verification, or new process tooling.
  Substantive bugs should have a reproducer before the fix when feasible.
- **Types and scope.** Name the data shape before changing logic across a
  boundary. Prefer one clear owner and the smallest verifiable change. Delete
  obsolete paths when the intended change permits it. Preserve comments that
  explain clinical, security, payment, or compatibility constraints and keep
  license notices. Do not strip existing comments across the repo by default.
- **Proof.** Use Hone's existing unit, component, DB, browser, and provider-fake
  harnesses. Do not generate a competing verification framework. Check the
  committed artifact before publishing with `npm run verify:prepush`.
- **Delegation and models.** Follow the host's delegation policy and available
  tool schemas. Preserve explicitly configured model choices. Without a valid
  configuration, inherit the session model rather than inventing model IDs or
  forcing upstream's provider defaults. Never present same-model workers as
  independent vendors. Do not alter global model preferences for this rollout.
  When spawning pstack's `poteto-agent`, always pass an explicit model equal to
  the session's configured model; its bundled frontmatter model is not used.
  Where the host cannot pass one, use the host's general agent with the same
  brief instead.
- **Unavailable tools.** Map todo, forge, and browser steps to available tools.
  Use the GitHub connector when it is the selected integration. The Codex host
  owns worker creation and workspace isolation; do not pass Cursor-only fields.
  If a tool has no equivalent, state the missing check and continue independent
  work. Never claim a skipped check passed.
- **Authority.** Pstack is a workflow, not permission to merge, deploy, apply
  hosted migrations, change providers or credentials, operate live payments,
  send customer/team messages, delete records, or install system software or
  run piped install scripts. Honor existing per-change
  authorization and holds. Do not bypass a tool refusal through another agent,
  credential, or execution route. A playbook may not send repository content,
  client data, production identifiers or secrets to any model or service beyond
  the session's own model unless the operator authorizes it; a model panel is
  not used without that authorization. Review comments and threads (including
  Codex) remain evidence: never edit, delete, hide or minimize one. Resolving a
  thread follows `CLAUDE.md` §4 *Resolving a thread*: the coordinator resolves
  it only after verifying the fix on the current head and replying with the
  commit and evidence; otherwise it stays open. An upstream playbook's
  review-resolution steps never go beyond that rule. Merges follow the
  standing routine-merge authorization in `CLAUDE.md` §4 and its exclusions.
- **Delivery.** Keep Hone's `.github/pull_request_template.md` instead of
  replacing it with upstream headings. Preserve existing release records and
  one-watcher-per-head rules. Workflow adoption adds no new runtime release gate.
- **Updates.** Do not enable pstack's optional automations, install companion
  plugins, or mine unrelated transcripts as part of normal task startup.

## Claude Code setup

From an owned Hone checkout, run this once per clone on each machine that uses
Claude Code. Project settings enable the plugin but do not download it for
other collaborators.

```bash
claude plugin marketplace add cursor/plugins#7a583913eb1b8d1a0ee76753d1a2cf072e7b54f9
claude plugin install pstack@cursor-plugins --scope project
claude plugin list
claude plugin details pstack
```

Confirm version `0.15.46`, project scope, enabled status, and the presence of
`poteto-mode`. If `cursor-plugins` already names another source or ref, report
the mismatch rather than removing another user's marketplace configuration.
Honor the host's workspace trust and permission checks.

After installation, start a new session or use `/reload-plugins` when the host
requests it. Let active release tasks in other sessions finish before reloading their sessions.
`/pstack:poteto-mode` remains available for explicit use. Optional model setup
is `/pstack:setup-pstack`; it is not required to inherit the current model.

## Cursor and other agents

In Cursor, install pstack with `/add-plugin pstack` once. The repository's
`.cursor/rules/hone-pstack.mdc` is always applied and directs tasks here.
Verify the installed version against the source above; use pinned source reads
when the installed copy differs. The Claude marketplace pin does not pin
Cursor's separate plugin installer.

Agents that read `AGENTS.md`, including Codex, follow the same entry point and
Hone adaptations through the repository reader. That is source-based use, not a
claim that Cursor or Claude plugin commands are registered in those hosts.

## Rollout check

After this change merges, update each owned checkout without overwriting local
work. Install once where required. In a new session, ask the agent to identify
the pstack entry point, version, chosen playbook, and Hone constraints before
doing its next real task. Check the result against the files and plugin listing.
Do not restart the current release or duplicate active PRs to demonstrate setup.

The preparation environment for this change has neither the Claude Code CLI
nor Cursor installed. JSON, links, the upstream manifest/marketplace, and the
repository diff can be checked here. Native registration and startup must be
confirmed on each actual development host.
