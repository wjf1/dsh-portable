# Add wjf1/dsh-portable

## What it does

dsh-portable packs a working DSH home into a single .dshpkg file (gzipped tar, manifest as the first entry) and restores it on another machine without network access and without pnpm install.

Roots collected (whitelist only — there is no recursive home-directory walk anywhere in the code):

- profiles/<name> — configuration and installed plugins with their node_modules
- skills and skills-disabled
- hooks and storages
- task-board / todo-board storage and dsh-builtin-browser-host
- AGENTS.md
- opt-in only: sessions, downloaded runtimes, .credentials.yaml, *.bak-* backups

On import it extracts into a staging directory, renames the profile when the target profile name differs, rewrites machine-local paths in the six configuration files that actually contain them (profiles/<p>/cordis.patch.yml, cordis.yml, package.json, pnpm-workspace.yaml, hooks/hooks.json, hooks/settings.json) — plugin package contents are never rewritten — backs those six files up, then applies each top-level item in merge mode (add and overwrite only) or replace mode (move aside first).

Surfaces:

- a Settings → Portable Migration panel (export, package list, upload, two-phase import, LAN share, backups)
- four model tools: portable_export, portable_inspect, portable_import, portable_share
- a no-host bootstrap CLI (bootstrap/install.ps1 and bootstrap/install.sh) for a machine that does not have DSH installed yet

## How it differs from existing entries

dsh-config-manager, also on this list, backs up and moves configuration — settings, plugin list, MCP servers, skills. dsh-portable moves the whole working directory tree, including the plugin node_modules that make a profile bootable offline, plus hooks, task boards, storages and AGENTS.md. It also ships an offline bootstrap path and a one-shot LAN download link. The two are complementary; this one exists for the air-gapped and no-pnpm case.

## Capability notes (relevant to the red-line check)

- Reads DSH_HOME and writes into it on import. Import is two-phase: POST /import without confirm:true returns 400 CONFIRM_REQUIRED, and the model tool portable_import without confirm is a dry run. The six configuration files are backed up before anything is written.
- Opens a local HTTP server. It reuses the host's existing web server through ctx.webServer.register (same port and same auth fence). The optional LAN share is a single-file, token-gated link with one download and 60 minutes by default.
- .credentials.yaml is omitted by default. It is included only when the user explicitly ticks the box, and that checkbox carries the warning. Export itself is a purely local operation — nothing is uploaded anywhere.
- Artifact ids, not paths. Every API and tool argument that names a package takes an id of the form exports:<file>.dshpkg; slashes, backslashes, .. and control characters are rejected, so the model cannot use this plugin to reach an arbitrary file.

## Checks

- npm test — 43 tests (tar including PAX padding across chunk boundaries, archive, installer, jobs, routes, share, inspect), all green.
- npm run check — syntax check plus import smoke test.
- Verified against a real DSH home: 13,774 entries and 20.7 MB exported in 2.8 s, then imported into a temporary home — 9 top-level items applied, 13,491 files, 3 files with 3 rewritten paths.
- The repository declares dsh.bundle.patch and dsh.client, and ships cordis.patch.yml.

## Notes

- MIT licensed, zero runtime dependencies, no build step.
- Node ^22.15.0 || >= 24.0.0, DSH >= 0.1.7-rc.2.
