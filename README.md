# dsh-dotnet-skills

Project-scoped .NET skills for DeepSeek Harness: **nothing is in your context until you ask for it**.

A composer button (`技能`) analyses the project you are working in, suggests the .NET skills that match its stack, and injects only those — into `<project>/.dsh/skills`, DSH's project skill root. Other projects, and sessions that never opened the panel, see nothing.

## Flow

```
composer button ──▶ analyse (local rules, no model, no network)
                     .csproj TFM + PackageReference, *.sln, global.json,
                     Directory.Packages.props, *.razor, *.xaml, *.proto,
                     appsettings.json, host.json, .editorconfig, …
                ──▶ panel: detected stack chips + searchable skill list (pre-selected)
                ──▶ confirm → copy the selection into <project>/.dsh/skills
                ──▶ DSH's filesystem provider reloads that project root; the next
                     model step sees a skill catalog containing exactly those skills
```

The button shows the injected count for the project, and the state is unified per project — every session working in that project sees the same injection.

## Detection rules

Pure code over the project files; each rule reports the evidence that fired it, and the panel shows the recognised stack as chips. Covered stacks include `.NET`/MSBuild, WinForms, WPF, WinUI, Avalonia, Uno, MAUI, ASP.NET Core, Minimal APIs, Blazor, gRPC, SignalR, EF Core, EF6, xUnit/NUnit/MSTest, Coverlet, Stryker, Playwright, Orleans, Aspire, Azure Functions, WCF, Workflow Foundation, Semantic Kernel, Agent Framework, Microsoft.Extensions.AI, ML.NET, MCP, CPM/NuGet, analyzers/formatting, solution architecture, `.binlog` diagnostics, BenchmarkDotNet, .NET 11, legacy .NET Framework and legacy ASP.NET.

## Behaviour

- **Cache, not injection** — the vendored checkout (`$DSH_HOME/vendor/dotnet-skills`) is refreshed every 6 hours (and shortly after start) with `git fetch` + `reset --hard`. It never enters the skill catalog by itself.
- **Project scoped** — `<project>/.dsh/skills` is the rank-100 project root DSH already watches, so injected skills hot-reload without a restart and never leak into another project.
- **Ownership** — `<project>/.dsh/dotnet-skills.json` records what this plugin injected. Clearing removes exactly those; a hand-written skill with the same name is never deleted.
- **Clean git** — `/.dsh/` is added to the project's `.git/info/exclude` (local only; no tracked `.gitignore` change).
- **Source switch** — a checkout whose `origin` differs from the configured `repoUrl` is discarded and cloned again.

## Tools

`dotnet_skills` — `status` (checkout state), `analyze` (detected stack, suggestions and the current injection), `sync` (refresh the checkout now).

`dotnet_skills_find` — search the catalog and list names with a one-line description:

```
dotnet_skills_find { query: "msbuild binlog" }
  - `msbuild` — Use before MSBuild custom-target or incremental-generation repairs…
  - `binlog-generation` — Generate MSBuild binary logs (binlogs) for build diagnostics…
```

`dotnet_skills_apply` — **append** skills to the current project's injected set (it never drops what the user chose), optionally dropping names:

```
dotnet_skills_apply { skills: ["binlog-generation"] }
dotnet_skills_apply { remove: ["binlog-generation"] }
```

The result lists each skill's `SKILL.md` path so the instructions can be read immediately; the skills also join the project catalog from the next step. The model can use this on its own when a task needs the depth — the composer panel remains the human's way to choose a project-wide set, and both write to the same place.

`dotnet_skills_load` was removed on purpose: one write path (apply) keeps the project injection and the catalog in sync instead of introducing a second, invisible way to read skills.

## Configuration

The `dotnet-skills` row of this bundle's `cordis.patch.yml`; override it from the profile's own `cordis.patch.yml` (a patch replaces the whole `config`):

| Key | Default | Meaning |
|---|---|---|
| `repoUrl` | `https://github.com/managedcode/dotnet-skills.git` | catalog source |
| `branch` | `main` | branch to track |
| `intervalHours` | `6` | checkout refresh interval |
| `runOnStart` | `true` | refresh once after start |
| `startDelaySeconds` | `20` | delay before that first refresh |
| `checkoutDir` | `$DSH_HOME/vendor/dotnet-skills` | shallow clone location |
| `gitCommand` | `git` | git executable when it is not on PATH |

## HTTP surface (same origin, JSON only)

| Route | Method | Purpose |
|---|---|---|
| `/dsh-dotnet-skills/state?sessionId=` | GET | project, detection, catalog, current injection |
| `/dsh-dotnet-skills/apply` | POST | `{sessionId, skills[]}` → inject and prune |
| `/dsh-dotnet-skills/clear` | POST | `{sessionId}` → remove everything this plugin injected |

Mutations require `content-type: application/json` and a same-origin `Origin`, so a cross-site form or a bare script cannot change a project's injection.

## Limitations

- Runs while DSH runs; the catalog refreshes at the next 6-hour check, not upstream's commit instant.
- Detection is rule-based: an unusual project layout can be under-detected, which is why the panel lets you search and add anything manually.
- Skill content is licensed by its upstream repository (`managedcode/dotnet-skills`).
