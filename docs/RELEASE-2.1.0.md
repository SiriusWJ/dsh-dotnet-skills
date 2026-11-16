## v2.1.0 — model-picked skills, two project copies, Microsoft Learn

### Selection is now the model's job
Rule table removed. The host gathers exact facts per project and one background
`ctx.llm` call picks the skills:

- target frameworks, package references (up to 60), SDK version from `global.json`
- structure signals: `Program.cs`/`Startup.cs`, razor, xaml/axaml, proto, `.http`,
  Dockerfile, GitHub workflows, `Directory.Packages.props`, `.editorconfig`, appsettings
- top 20 `using` namespaces with counts, top 10 `namespace`s, README head
- the prompt must ground every pick in that evidence and use the README to tell an
  app from a library; reasons are written in the UI language

Up to `selectMaxSkills` (default 10, range 1–50) picks, ranked by relevance, cached
per `(head, facts, language)` for 30 minutes. `重新分析` bypasses the cache and shows
the waiting state; an existing selection opens instantly without a model call.

### Two real copies, kept in sync
```
<project>/.dsh/Skills/DotnetSkills/<skill>/…   managed repository
<project>/.dsh/skills/<skill>/…                the copy DSH discovers
```
When the background fetch brings a new head, every project this plugin has filled is
refreshed: changed fingerprints are rewritten in both copies, vanished skills are
dropped. Roots are tracked in `$DSH_HOME/dotnet-skills.projects.json`.

### Settings live in Plugins → Installed
A `Config` schema plus a `plugins.bundle.config` page render the two knobs
(refresh interval 6 h/12 h/1 d/3 d/1 w, max picks 1–50); saves go through the config
editor and restart the plugin. The in-panel settings view is gone.

### Microsoft Learn, per working directory
The panel's header pill toggles the public Learn MCP server for that project. The
process-wide MCP client mounts while any known project wants it and is disposed when
the last one turns it off; turning it on installs the `mslearn` CLI when missing.
Tools appear as `mcp__microsoft-learn-cli__*`.

### Panel
Frame-wide overlay (centred, unclipped), readable scrollbar, selected rows first,
clear session/scope/skill-folder labels, and a footer that shows the settings in force.

### Fixed
- every plugin reload leaked its web routes, so the panel kept being served by the
  first instance; registrations now dispose with the fiber
- `execFile('npm.cmd')` threw `spawn EINVAL` on Windows and left the CLI install
  hanging; npm now runs through `cmd.exe`
- the Learn switch and the count badge used theme tokens that render white here

### Tests
`node test/smoke.mjs` (facts, model-output parsing, provenance) and
`node test/layout.mjs` (two copies, catalog sync, clear).
