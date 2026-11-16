# dsh-dotnet-skills

Keeps a GitHub .NET skill catalog mirrored into the DSH user skill root, and checks for updates on a timer — **every 6 hours by default**, plus once shortly after DSH starts.

Default source: [managedcode/dotnet-skills](https://github.com/managedcode/dotnet-skills) (203 skills in 5 collections). [dotnet/skills](https://github.com/dotnet/skills) works too, because discovery understands several layouts.

## Why a mirror exists at all

DSH discovers local skills one level deep: `$DSH_HOME/skills/<name>/SKILL.md`.
Repositories nest them more deeply:

| Repository | Layout |
|---|---|
| `managedcode/dotnet-skills` | `catalog/<Collection>/<Package>/skills/<name>/SKILL.md` |
| `dotnet/skills` | `plugins/<plugin>/skills/<name>/SKILL.md` |
| plain collections | `skills/<name>/SKILL.md` |

The plugin shallow-clones the repository, walks `catalog/`, `plugins/` and `skills/` with a bounded depth (skipping site, CLI and vendored copies), and flattens every skill into the skill root, so DSH's own filesystem provider discovers and hot-reloads them — no restart.

## Behaviour

- **Timer** — one check (`git fetch` + `reset --hard`, then a mirror pass) every `intervalHours` (default 6), and one shortly after start.
- **Source switch** — a checkout whose `origin` differs from the configured `repoUrl` is discarded and cloned again instead of silently mirroring the wrong catalog.
- **Incremental** — a skill whose files are unchanged is not rewritten; a changed one is overwritten in place (Windows-safe, with retries when a scanner or watcher holds a handle).
- **Ownership** — only directories recorded in `$DSH_HOME/dotnet-skills.manifest.json` are ever pruned. A same-named directory the user created is skipped, never touched.
- **Failure containment** — a failed git step records the error and keeps the previous mirror; nothing is pruned.
- **Clean checkout** — the managed directory names are written to the skill root's `.git/info/exclude` when that root is a git repository, so the user's own skill repository stays clean without a tracked `.gitignore` change.
- **Status** — `$DSH_HOME/dotnet-skills.status.json` records the latest check, read back after a restart.

## Tools

`dotnet_skills` — `action: "status"` reports the timer, the last result and the next check; `action: "sync"` forces one check now.

## Configuration

Everything lives in the `dotnet-skills` row of this bundle's `cordis.patch.yml`; override it from the profile's own `cordis.patch.yml` (a patch replaces the whole `config`, so restate every key you need):

| Key | Default | Meaning |
|---|---|---|
| `repoUrl` | `https://github.com/managedcode/dotnet-skills.git` | source repository |
| `branch` | `main` | branch to track |
| `intervalHours` | `6` | check interval |
| `runOnStart` | `true` | run one check after start |
| `startDelaySeconds` | `20` | delay before that first check |
| `checkoutDir` | `$DSH_HOME/vendor/dotnet-skills` | shallow clone location |
| `skillsRoot` | `$DSH_HOME/skills` | mirror destination |
| `include` | `[]` | keep only these collections / packages / skill names |
| `exclude` | `[]` | skip these collections / packages / skill names |
| `gitCommand` | `git` | git executable when it is not on PATH |

`include` and `exclude` match a collection (top level under `catalog/`), a package directory, or a skill name, case-insensitively:

```yaml
exclude: [Mobile, XR]        # drop two collections
include: [Frameworks, Testing]
```

## Cost note

Every mirrored skill appears in the session skill catalog with a description capped at 500 characters. The full 203-skill catalog costs roughly 25k tokens per request; a curated `include`/`exclude` keeps only what a project needs.

## Limitations

- Runs only while DSH runs; updates land at the next check, not at the instant upstream commits.
- A checked-out repository and its mirror are local state; removing this bundle leaves them in place.
- Skill content is licensed by its upstream repositories (see their LICENSE files).
