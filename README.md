# dsh-dotnet-skills

Project-scoped .NET skills for DeepSeek Harness: **nothing is in your context until you ask for it**.

A composer button (`技能`) analyses the project you are working in, suggests the .NET skills that match its stack, and injects only those — into `<project>/.dsh/skills`, DSH's project skill root. Other projects, and sessions that never opened the panel, see nothing.

## Flow

```
composer button ──▶ host gathers project facts (TFMs, package references,
                     project names, file mix — no guessing)
                ──▶ one background `ctx.llm` call: the current model sees the
                     facts + the whole catalog and picks ≤ 8 skills with reasons
                ──▶ panel: facts chips + the model's picks (pre-selected) +
                     searchable catalog for anything else, plus 重新分析
                ──▶ confirm → copy the selection into <project>/.dsh/skills
                ──▶ DSH's filesystem provider reloads that project root; the next
                     model step sees a skill catalog containing exactly those skills
```

Selection is cached per (checkout head, project facts) for 30 minutes, so reopening the panel is instant; `重新分析` forces a fresh model call.

The button shows the injected count for the project, and the state is unified per project — every session working in that project sees the same injection.

## Why the model picks, not a rule table

The first version mapped project files to catalog packages with a rule table. It over-suggested (one common package pulled in a whole package's skills) and missed nuance. The facts are still gathered locally — that is cheap and exact — but the *judgement* now comes from the model, which can weigh "this project has EF Core but the work is about a WinForms grid" and pick two skills instead of twenty.

## Detection

Two layers, deliberately split:

- **Facts** (local, exact, cheap): target frameworks, `PackageReference`/`PackageVersion` names, project names and counts, and the file mix, gathered from `<project>` with bounded traversal.
- **Judgement** (one background model call): the facts plus the whole catalog go to the current model, which returns at most `selectMaxSkills` (default 10), most relevant first skills with a one-line reason each.

The panel shows the facts as chips, the model's picks pre-selected with their reasons, and the full catalog for anything else. When the model route is unavailable the panel says so and preselects nothing — it never falls back to a rule table.

## Behaviour

- **Cache, not injection** — the vendored checkout (`$DSH_HOME/vendor/dotnet-skills`) is refreshed every 6 hours (and shortly after start) with `git fetch` + `reset --hard`. It never enters the skill catalog by itself.
- **Project scoped** — `<project>/.dsh/skills` is the rank-100 project root DSH already watches, so injected skills hot-reload without a restart and never leak into another project.
- **Ownership** — `<project>/.dsh/dotnet-skills.json` records what this plugin injected. Clearing removes exactly those; a hand-written skill with the same name is never deleted.
- **Clean git** — `/.dsh/` is added to the project's `.git/info/exclude` (local only; no tracked `.gitignore` change).
- **Source switch** — a checkout whose `origin` differs from the configured `repoUrl` is discarded and cloned again.

## Tools

One model-facing tool, three actions:

| Call | Result |
|---|---|
| `dotnet_skills { action: "find", query: "msbuild binlog" }` | matching skills: name + one-line description |
| `dotnet_skills { action: "find" }` | detect the project's stack, list the skills that fit, and show the current injection |
| `dotnet_skills { action: "add", skills: ["binlog-generation"] }` | add to the project's set (never drops the user's picks); returns each `SKILL.md` path |
| `dotnet_skills { action: "remove", skills: ["binlog-generation"] }` | remove **only skills this tool added**; user-injected ones are protected |

`find` without a query is the old `analyze`, which is why the separate tool is gone. Refreshing the checkout is not a tool action: the host does it on its timer (every 6 hours, plus shortly after start), so the model never needs to know how the cache works.

### Who owns what

The project manifest records the injector of every skill:

- `user` — chosen from the composer panel (a human decision);
- `model` — added by `action: add`.

`action: remove` only deletes `model` entries and reports the `user` ones it kept, so an agent that changes its mind can clean up after itself without touching what you chose. Manifests written before this rule existed (fingerprint only) are treated as `user` — the safe side.

The panel itself (routes `/dsh-dotnet-skills/apply`, `/clear`) always acts as the human: it replaces the whole selection, and clearing removes everything this plugin owns.

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
| `/dsh-dotnet-skills/state?sessionId=&refresh=1` | GET | project facts, model-picked suggestions, catalog, current injection (`refresh=1` re-runs the model call) |
| `/dsh-dotnet-skills/apply` | POST | `{sessionId, skills[]}` → inject and prune |
| `/dsh-dotnet-skills/clear` | POST | `{sessionId}` → remove everything this plugin injected |

Mutations require `content-type: application/json` and a same-origin `Origin`, so a cross-site form or a bare script cannot change a project's injection.

## Limitations

- Runs while DSH runs; the catalog refreshes at the next 6-hour check, not upstream's commit instant.
- The model's picks are cached for 30 minutes per (checkout head, project facts); use `重新分析` for a fresh call.
- One panel analysis costs one auxiliary model request (facts + catalog ≈ 7k input tokens, ≤700 output); reopening the panel is free until the cache expires.
- Skill content is licensed by its upstream repository (`managedcode/dotnet-skills`).
