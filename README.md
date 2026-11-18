# dsh-dotnet-skills

English | [中文](./README.zh.md)

Project-scoped .NET skills for DeepSeek Harness. A composer button reads the project, asks the current model which of 203 catalog skills actually fit, and copies only those into the project — plus an optional Microsoft Learn MCP server and its `mslearn` CLI.

Nothing is mirrored into the user skill root: another project, or another user, never sees this project's selection.

## Flow

```text
composer button (dotnet技能)
  ├─ facts      local, exact: target frameworks, package references, SDK version,
  │             structure signals (Program.cs, razor, xaml, proto, Dockerfile,
  │             workflows, appsettings…), top usings/namespaces, README head
  ├─ judgement  one background ctx.llm call: facts + the whole catalog → ≤ N skills,
  │             each with a one-line reason, grounded in the facts above
  └─ inject     two real copies inside the project (see Layout)
```

The pick is cached per `(catalog head, project facts, UI language)` for 30 minutes; `重新分析` bypasses the cache and waits for a fresh call. Opening the panel when skills are already injected does **not** call the model — it just shows the current selection.

## Catalog: a superset of the official .NET skills

The catalog comes from [`managedcode/dotnet-skills`](https://github.com/managedcode/dotnet-skills) — 203 skills in five collections (Tools, Frameworks, Testing, Platform, Libraries).

It is a **superset of the official Microsoft .NET skills curated in [`dotnet/skills`](https://github.com/dotnet/skills)**: all **108** skills that repository publishes are present here under the same names, plus **95** community skills (verified against `dotnet/skills@main` when this file was written). Nothing in the official collection is dropped or renamed, so you can swap one source for the other without losing coverage.

Only the skills a project actually needs are copied into it; the catalog itself stays a checkout under `$DSH_HOME/vendor/dotnet-skills`, refreshed on the configured interval. Point `repoUrl` at another catalog (including `dotnet/skills` itself) if you would rather track a different source.

## Requirements

| Item | Value |
|---|---|
| DeepSeek Harness | `>=0.2.2-rc.1 <0.3.0`, declared as `engines.dsh` — a host outside that range refuses the install instead of half-working |
| Node.js | whatever the running DSH uses (22+) |
| `git` on the DSH process's PATH | needed for the catalog checkout; override with `gitCommand` |
| Network | `github.com` for the catalog, `learn.microsoft.com` only when the Learn MCP server is on |

## Layout

```text
<project>/.dsh/
├── Skills/DotnetSkills/<skill>/…   the managed repository this plugin owns
├── skills/<skill>/…                the copy DSH discovers (roots are one level deep)
└── dotnet-skills.json              manifest: fingerprints, ownership, learnMcp
```

On Windows `.dsh/Skills` and `.dsh/skills` are the same directory, so the repository sits at `.dsh/skills/DotnetSkills/`. DSH ignores that container because it holds no `SKILL.md` directly.

Both copies are written and removed together; the second is copied from the first, so the project stays usable even if the checkout disappears.

## Keeping up to date

The host refreshes the catalog checkout on a timer (default 6 h, plus once shortly after start). When the fetched head changes, every project this plugin has filled is refreshed: changed fingerprints are rewritten in both copies, skills that disappeared upstream are dropped. Project roots are tracked in `$DSH_HOME/dotnet-skills.projects.json`.

## Microsoft Learn

The panel's top-right pill toggles the public Microsoft Learn MCP server (`https://learn.microsoft.com/api/mcp`) **for that working directory**. The choice is stored in the project manifest; the process-wide `@deepseek-ai/dsh-mcp-client` child plugin is mounted while at least one known project wants it, and disposed when the last one turns it off. Turning it on also makes sure the `@microsoft/learn-cli` (`mslearn`) CLI is installed globally, detecting an existing install first. Tools appear as `mcp__microsoft-learn-cli__*`.

## Tool

`dotnet_skills` — the model-facing half of the same catalog:

| Action | Result |
|---|---|
| `find` with `query` | keyword search over the catalog (name, package, description) |
| `find` without `query` | the project's facts and current injection, no rule guessing |
| `add` | adds skills, records them as `model`-owned |
| `remove` | removes only `model`-owned skills; reports `user`-owned ones it kept |
| `probe` | runs the panel's model selection once and prints the raw result (diagnostics) |

## Configuration

**Plugins → Installed → dsh-dotnet-skills** renders the two panel knobs from a `Config` schema; saving goes through the config editor, which restarts the plugin.

| Key | Default | Meaning |
|---|---|---|
| `intervalHours` | `6` | catalog refresh interval: `6`, `12`, `24`, `72`, `168` (6 h / 12 h / 1 day / 3 days / 1 week) |
| `selectMaxSkills` | `10` | how many skills the model may pick per project, `1`–`50` |
| `repoUrl` / `branch` | managedcode/dotnet-skills, `main` | catalog source |
| `runOnStart` / `startDelaySeconds` | `true`, `20` | refresh once after start, after this delay |
| `checkoutDir` | `$DSH_HOME/vendor/dotnet-skills` | shallow clone location |
| `selectTimeoutMs` | `45000` | timeout of one panel analysis |

`gitCommand` is not in the form; set it in the profile patch when `git` is not on the DSH process's PATH.

## HTTP surface (same origin, JSON only)

| Route | Method | Purpose |
|---|---|---|
| `/dsh-dotnet-skills/state?sessionId=&lang=&refresh=1` | GET | facts, model picks with reasons, catalog, current injection (`refresh=1` re-runs the model) |
| `/dsh-dotnet-skills/apply` | POST | `{sessionId, skills[], lang}` → replace the selection (the panel acts as the human) |
| `/dsh-dotnet-skills/clear` | POST | `{sessionId, lang}` → remove everything this plugin owns |
| `/dsh-dotnet-skills/settings` | GET/POST | read or save the two knobs |
| `/dsh-dotnet-skills/learn` | POST | `{sessionId, enabled}` → per-project Microsoft Learn switch |

Mutations require a JSON content type and same-origin; the desktop app sends both.

## Ownership

Every manifest entry records who injected it: `user` (composer panel) or `model` (`dotnet_skills add`). `remove` deletes only `model` entries, so an agent can undo its own changes without deleting a human's selection.

## Limitations

- DSH discovers skills one level deep, hence the flat `.dsh/skills/<name>` copy; a nested container would never be read.
- One panel analysis costs one auxiliary model request (facts + catalog ≈ 7k input tokens, ≤700 output); reopening is free for 30 minutes.
- The model picks; local rules only gather facts. An unusual layout (no project files, generated code) leaves it little to work with.
- The MCP server is process-wide while any project wants it; per-project isolation is at the tooling level, not the socket level.

## Development

```bash
node test/smoke.mjs    # facts, JSON parsing, provenance
node test/layout.mjs   # two copies, catalog sync, clear
```
