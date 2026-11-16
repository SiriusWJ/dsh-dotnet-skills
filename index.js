/**
 * dsh-dotnet-skills — keep a GitHub .NET skill catalog mirrored into the DSH
 * user skill root, on a timer.
 *
 * Why a plugin instead of a shell script: the update has to happen while DSH is
 * running (that is exactly when a new skill matters), with no OS scheduler
 * rights, no token cost, and no dependency on the user's login. A Host row with
 * a timer does that; the skills themselves stay ordinary markdown on disk, so
 * DSH's own filesystem provider discovers and reloads them.
 *
 * Repositories nest their skills differently while DSH discovers only
 * `$DSH_HOME/skills/<name>/SKILL.md` (one level deep):
 *
 *   managedcode/dotnet-skills  catalog/<Collection>/<Package>/skills/<name>/SKILL.md
 *   dotnet/skills              plugins/<plugin>/skills/<name>/SKILL.md
 *   plain collections          skills/<name>/SKILL.md
 *
 * so discovery walks `catalog/`, `plugins/` and `skills/` (bounded depth, site
 * and vendored copies skipped) and flattens every skill into the skill root.
 *
 * Ownership rules:
 *   - Only directories recorded in the manifest are ever deleted.
 *   - A name that exists but is not recorded is the user's own skill: skipped.
 *   - A failed git step never prunes: the previous known-good mirror stays.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

export const inject = ["tools"];

const ROW_ID = "dotnet-skills";
const TAG = "dsh-dotnet-skills";
const LOG_LIMIT = 40;
const GIT_TIMEOUT_MS = 180_000;

const BLOCK_BEGIN = "# >>> dsh-dotnet-skills (managed) >>>";
const BLOCK_END = "# <<< dsh-dotnet-skills <<<";
/** Markers of the earlier one-off PowerShell sync, replaced when seen. */
const LEGACY_BLOCKS = [
  ["# >>> dotnet-skills (managed by sync-dotnet-skills.ps1) >>>", "# <<< dotnet-skills <<<"],
];

const DEFAULTS = {
  repoUrl: "https://github.com/managedcode/dotnet-skills.git",
  branch: "main",
  checkoutDir: "",
  skillsRoot: "",
  intervalHours: 6,
  runOnStart: true,
  startDelaySeconds: 20,
  include: [],
  exclude: [],
  gitCommand: "git",
};

/* ------------------------------------------------------------------ *
 * paths and small helpers
 * ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? "").trim();
  return fromEnv === "" ? join(homedir(), ".dsh") : fromEnv;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function toList(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter((entry) => entry !== "") : [];
}

function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  const home = dshHome();
  return {
    ...merged,
    checkoutDir: String(merged.checkoutDir ?? "").trim() || join(home, "vendor", "dotnet-skills"),
    skillsRoot: String(merged.skillsRoot ?? "").trim() || join(home, "skills"),
    intervalHours: Math.max(0.05, Number(merged.intervalHours) || DEFAULTS.intervalHours),
    startDelaySeconds: Math.max(0, Number(merged.startDelaySeconds) || 0),
    runOnStart: merged.runOnStart !== false,
    include: toList(merged.include),
    exclude: toList(merged.exclude),
    manifestPath: join(home, "dotnet-skills.manifest.json"),
    statusPath: join(home, "dotnet-skills.status.json"),
  };
}

/* ------------------------------------------------------------------ *
 * git
 * ------------------------------------------------------------------ */

function gitCandidates(configured) {
  const list = [String(configured ?? "git").trim() || "git"];
  if (process.platform === "win32") {
    list.push(
      join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Git", "cmd", "git.exe"),
      join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "cmd", "git.exe"),
    );
  }
  return [...new Set(list.filter((entry) => entry !== ""))];
}

/** Compare remotes regardless of trailing slash, `.git` suffix or SSH vs HTTPS. */
function normalizeRemote(url) {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^git@([^:]+):/u, "https://$1/")
    .replace(/\.git$/u, "")
    .replace(/\/+$/u, "");
}

function runGit(candidates, args, cwd) {
  const attempt = (index) =>
    new Promise((resolve) => {
      const command = candidates[index];
      execFile(
        command,
        args,
        { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && error.code === "ENOENT" && index + 1 < candidates.length) {
            resolve(attempt(index + 1));
            return;
          }
          resolve({
            ok: !error,
            code: error === null ? 0 : (error.code ?? -1),
            stdout: String(stdout ?? "").trim(),
            stderr: String(stderr ?? "").trim() || (error === null ? "" : String(error.message ?? error)),
          });
        },
      );
    });
  return attempt(0);
}

/* ------------------------------------------------------------------ *
 * manifest: what this plugin owns in the skill root
 * ------------------------------------------------------------------ */

function readManifest(path) {
  try {
    if (!existsSync(path)) return { version: 1, skills: {} };
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) {
      return { version: 1, skills: Object.fromEntries(raw.map((name) => [String(name), {}])) };
    }
    if (raw !== null && typeof raw === "object" && raw.skills !== null && typeof raw.skills === "object") {
      return { version: 1, skills: raw.skills };
    }
    return { version: 1, skills: {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

/* ------------------------------------------------------------------ *
 * filesystem mirror
 * ------------------------------------------------------------------ */

/** Directory fingerprint, so unchanged skills are not rewritten every check. */
function fingerprint(directory) {
  let size = 0;
  let mtime = 0;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        const stat = statSync(path);
        size += stat.size;
        if (stat.mtimeMs > mtime) mtime = stat.mtimeMs;
      } catch {
        /* a file vanished mid-walk; the next run corrects it */
      }
    }
  };
  walk(directory);
  return `${size}:${Math.round(mtime)}`;
}

/**
 * Windows raises EPERM/EBUSY/EIO when an antivirus scanner, an indexer or the
 * skill watcher still holds a handle on the directory being replaced. Those are
 * transient: retry a few times with a short backoff instead of failing the run.
 */
const RETRYABLE = new Set(["EPERM", "EBUSY", "EIO", "EACCES", "ENOTEMPTY"]);

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* no SharedArrayBuffer: skip the backoff rather than fail the copy */
  }
}

function withRetry(operation, attempts = 5) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error?.code)) throw error;
      sleepSync(80 * (index + 1));
    }
  }
  throw lastError;
}

/**
 * Copy a skill directory into place without deleting the destination first.
 *
 * Deleting a watched directory and recreating it is what failed on Windows:
 * the watcher (and Defender) briefly hold handles on the tree. Overwriting each
 * file in place, then removing only the extras, keeps the same directory entry
 * so the watcher sees ordinary edits.
 */
function mergeCopy(source, target) {
  if (!existsSync(target)) withRetry(() => mkdirSync(target, { recursive: true }));
  const names = new Set();
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    names.add(entry.name);
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      mergeCopy(from, to);
      continue;
    }
    withRetry(() => copyFileSync(from, to));
  }
  let present = [];
  try {
    present = readdirSync(target, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of present) {
    if (names.has(entry.name)) continue;
    const path = join(target, entry.name);
    withRetry(() => rmSync(path, { recursive: true, force: true }));
  }
}

/** Candidate skills: any directory carrying SKILL.md inside a search root. */
const SEARCH_ROOTS = ["catalog", "plugins", "skills"];
const MAX_DEPTH = 4;
/** Repositories carry site, CLI and vendored copies that must not become skills. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".github",
  ".gitlab",
  ".idea",
  ".vscode",
  ".claude",
  "external-sources",
  "docs",
  "tests",
  "test",
  "output",
  "artifacts",
  "github-pages",
  "cli",
  "scripts",
  "config",
]);

function collectSkillDirs(root, depth, out) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (existsSync(join(path, "SKILL.md"))) {
      out.push({ dir: path, name: entry.name });
      continue; // its subtree holds resources, not more skills
    }
    collectSkillDirs(path, depth + 1, out);
  }
}

/** `include`/`exclude` match a collection (top level), a package, or the skill name. */
function segmentMatches(list, segments, name) {
  if (list.length === 0) return false;
  const lowered = new Set(list.map((entry) => entry.toLowerCase()));
  if (lowered.has(name.toLowerCase())) return true;
  return segments.some((segment) => lowered.has(segment.toLowerCase()));
}

/** Filters out the search root, the `skills/` level and the skill directory. */
function relevantSegments(checkoutDir, directory) {
  const parts = relative(checkoutDir, directory).split(sep);
  parts.pop(); // the skill directory itself
  parts.shift(); // the search root (catalog / plugins / skills)
  return parts.filter((part) => part !== "" && part.toLowerCase() !== "skills");
}

function discover(checkoutDir, cfg, warnings) {
  const found = [];
  const seen = new Map();
  for (const rootName of SEARCH_ROOTS) {
    const root = join(checkoutDir, rootName);
    if (!existsSync(root)) continue;
    const candidates = [];
    collectSkillDirs(root, 0, candidates);
    for (const candidate of candidates) {
      if (!KEBAB.test(candidate.name)) {
        warnings.push(`${candidate.name}: not a kebab-case skill name, skipped`);
        continue;
      }
      if (seen.has(candidate.name)) {
        warnings.push(`${candidate.name}: duplicate name, ${seen.get(candidate.name)} wins`);
        continue;
      }
      const segments = relevantSegments(checkoutDir, candidate.dir);
      if (cfg.include.length > 0 && !segmentMatches(cfg.include, segments, candidate.name)) continue;
      if (segmentMatches(cfg.exclude, segments, candidate.name)) continue;
      seen.set(candidate.name, segments.join("/") || rootName);
      found.push({ name: candidate.name, segments, source: candidate.dir });
    }
  }
  return found;
}

/** Rewrite the local-only ignore block in the skill root's git checkout. */
function writeExcludeBlock(skillsRoot, names) {
  const gitDir = join(skillsRoot, ".git");
  if (!existsSync(gitDir)) return false;
  const excludePath = join(gitDir, "info", "exclude");
  const blocks = [[BLOCK_BEGIN, BLOCK_END], ...LEGACY_BLOCKS];
  let kept = [];
  if (existsSync(excludePath)) {
    let skipping = false;
    for (const line of readFileSync(excludePath, "utf8").split(/\r?\n/u)) {
      if (blocks.some(([begin]) => line === begin)) {
        skipping = true;
        continue;
      }
      if (blocks.some(([, end]) => line === end)) {
        skipping = false;
        continue;
      }
      if (!skipping) kept.push(line);
    }
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const block = [BLOCK_BEGIN, ...names.map((name) => `/${name}/`), BLOCK_END];
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, [...kept, "", ...block].join("\n") + "\n", "utf8");
  return true;
}

/**
 * Mirror the checkout into the skill root.
 * @returns `{ skills, collections, copied, pruned, skipped, unchanged }`
 */
function mirror(checkoutDir, cfg, warnings) {
  const manifest = readManifest(cfg.manifestPath);
  const skills = discover(checkoutDir, cfg, warnings);
  const results = {
    skills: skills.length,
    collections: new Set(skills.map((entry) => entry.segments[0] ?? "")).size,
    copied: 0,
    pruned: 0,
    skipped: 0,
    unchanged: 0,
  };
  const next = {};

  mkdirSync(cfg.skillsRoot, { recursive: true });

  for (const skill of skills) {
    const target = join(cfg.skillsRoot, skill.name);
    const owned = Object.prototype.hasOwnProperty.call(manifest.skills, skill.name);
    if (existsSync(target) && !owned) {
      warnings.push(`${skill.name}: exists and is not managed here, left alone`);
      results.skipped += 1;
      continue;
    }
    const prints = fingerprint(skill.source);
    next[skill.name] = { fingerprint: prints };
    if (owned && manifest.skills[skill.name]?.fingerprint === prints && existsSync(join(target, "SKILL.md"))) {
      results.unchanged += 1;
      continue;
    }
    mergeCopy(skill.source, target);
    results.copied += 1;
  }

  for (const stale of Object.keys(manifest.skills)) {
    if (Object.prototype.hasOwnProperty.call(next, stale)) continue;
    const target = join(cfg.skillsRoot, stale);
    if (existsSync(target)) {
      rmSync(target, { recursive: true, force: true });
      results.pruned += 1;
    }
  }

  writeFileSync(cfg.manifestPath, `${JSON.stringify({ version: 1, skills: next }, null, 2)}\n`, "utf8");
  writeExcludeBlock(cfg.skillsRoot, Object.keys(next).sort());
  return results;
}

/* ------------------------------------------------------------------ *
 * update run
 * ------------------------------------------------------------------ */

function createUpdater(cfg, warn) {
  const state = {
    running: false,
    lastCheckAt: null,
    lastResult: null,
    nextCheckAt: null,
    logs: [],
  };

  try {
    const saved = JSON.parse(readFileSync(cfg.statusPath, "utf8"));
    if (saved !== null && typeof saved === "object") {
      state.lastCheckAt = saved.lastCheckAt ?? null;
      state.lastResult = saved.lastResult ?? null;
    }
  } catch {
    /* no previous run recorded */
  }

  const log = (line) => {
    state.logs.push(`${new Date().toISOString()} ${line}`);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
  };

  const persist = () => {
    try {
      writeFileSync(cfg.statusPath, `${JSON.stringify({ lastCheckAt: state.lastCheckAt, lastResult: state.lastResult }, null, 2)}\n`, "utf8");
    } catch {
      /* status is a convenience, never a source of truth */
    }
  };

  const updater = {
    state,
    /** One check: clone or fetch, then mirror. Never throws. */
    async run(trigger = "interval") {
      if (state.running) return { ok: false, reason: "an update is already running", state: status() };
      state.running = true;
      const startedAt = new Date().toISOString();
      const warnings = [];
      const result = { trigger, startedAt, ok: false, clone: false, recloned: false, headBefore: null, headAfter: null, skills: 0, collections: 0, copied: 0, pruned: 0, skipped: 0, unchanged: 0, changed: false, warnings, error: null };
      const git = gitCandidates(cfg.gitCommand);
      try {
        log(`update (${trigger}) from ${cfg.repoUrl}`);
        if (existsSync(join(cfg.checkoutDir, ".git"))) {
          // A checkout of another repository would silently mirror the wrong
          // catalog, so a changed `repoUrl` replaces the checkout entirely.
          const origin = await runGit(git, ["-C", cfg.checkoutDir, "remote", "get-url", "origin"], undefined);
          if (!origin.ok || normalizeRemote(origin.stdout) !== normalizeRemote(cfg.repoUrl)) {
            rmSync(cfg.checkoutDir, { recursive: true, force: true });
            result.recloned = true;
            log(`checkout origin changed (${origin.ok ? origin.stdout : "unknown"}), re-cloning`);
          }
        }
        if (!existsSync(join(cfg.checkoutDir, ".git"))) {
          mkdirSync(dirname(cfg.checkoutDir), { recursive: true });
          const cloned = await runGit(git, ["clone", "--depth", "1", "--branch", cfg.branch, cfg.repoUrl, cfg.checkoutDir], dirname(cfg.checkoutDir));
          if (!cloned.ok) throw new Error(`git clone failed: ${cloned.stderr || cloned.code}`);
          result.clone = true;
          log(`cloned into ${cfg.checkoutDir}`);
        } else {
          const before = await runGit(git, ["-C", cfg.checkoutDir, "rev-parse", "HEAD"], undefined);
          result.headBefore = before.ok ? before.stdout : null;
          const fetched = await runGit(git, ["-C", cfg.checkoutDir, "fetch", "--depth", "1", "origin", cfg.branch], undefined);
          if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr || fetched.code}`);
          const reset = await runGit(git, ["-C", cfg.checkoutDir, "reset", "--hard", "FETCH_HEAD"], undefined);
          if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr || reset.code}`);
        }
        const after = await runGit(git, ["-C", cfg.checkoutDir, "rev-parse", "HEAD"], undefined);
        result.headAfter = after.ok ? after.stdout : null;
        result.changed = result.clone || result.recloned || result.headBefore !== result.headAfter;

        const mirrored = mirror(cfg.checkoutDir, cfg, warnings);
        Object.assign(result, mirrored);
        result.ok = true;
        state.lastCheckAt = new Date().toISOString();
        state.lastResult = result;
        log(`ok: ${result.skills} skills in ${result.collections} collections (${result.copied} changed, ${result.pruned} pruned, ${result.unchanged} unchanged)`);
        if (warnings.length > 0) log(`${warnings.length} warning(s): ${warnings.slice(0, 5).join("; ")}`);
      } catch (error) {
        result.error = String(error?.message ?? error);
        state.lastCheckAt = new Date().toISOString();
        state.lastResult = result;
        log(`failed: ${result.error}`);
        warn(`update failed: ${result.error}`);
      } finally {
        state.running = false;
        persist();
      }
      return { ...result, state: status() };
    },
  };

  function status() {
    const next =
      typeof state.lastCheckAt === "string" && Number.isFinite(Date.parse(state.lastCheckAt))
        ? new Date(Date.parse(state.lastCheckAt) + cfg.intervalHours * 3600_000).toISOString()
        : `within ${cfg.intervalHours}h of DSH start`;
    return {
      running: state.running,
      lastCheckAt: state.lastCheckAt,
      lastResult: state.lastResult,
      intervalHours: cfg.intervalHours,
      nextCheckAt: next,
      checkoutDir: cfg.checkoutDir,
      skillsRoot: cfg.skillsRoot,
      repoUrl: cfg.repoUrl,
      branch: cfg.branch,
      filters: { include: cfg.include, exclude: cfg.exclude },
      logs: state.logs.slice(-10),
    };
  }

  updater.status = status;
  return updater;
}

/* ------------------------------------------------------------------ *
 * tool
 * ------------------------------------------------------------------ */

function formatStatus(status, verbose) {
  const last = status.lastResult;
  const lines = [
    `dotnet skills sync — every ${status.intervalHours}h${status.running ? " (running now)" : ""}`,
    `repo           : ${status.repoUrl}#${status.branch}`,
    `checkout       : ${status.checkoutDir}`,
    `skill root     : ${status.skillsRoot}`,
    `last check     : ${status.lastCheckAt ?? "never"}`,
    `next check     : ${status.nextCheckAt}`,
  ];
  if (last !== null) {
    lines.push(
      `last result    : ${last.ok ? "ok" : `failed — ${last.error ?? "unknown"}`}`,
      `mirrored       : ${last.skills} skills / ${last.collections} collections (head ${String(last.headAfter ?? "?").slice(0, 8)})`,
      `this run       : ${last.copied} written, ${last.pruned} pruned, ${last.unchanged} unchanged, ${last.skipped} skipped`,
    );
    if (last.warnings?.length > 0) lines.push(`warnings       : ${last.warnings.length} (see logs)`);
  } else {
    lines.push("last result    : no check yet in this session");
  }
  const filters = status.filters;
  if (filters.include.length > 0) lines.push(`include filter : ${filters.include.join(", ")}`);
  if (filters.exclude.length > 0) lines.push(`excluded       : ${filters.exclude.join(", ")}`);
  if (verbose && status.logs.length > 0) {
    lines.push("", "recent log:", ...status.logs.map((line) => `  ${line}`));
  }
  return lines.join("\n");
}

function registerTool(ctx, warn, updater) {
  try {
    ctx.inject(["tools"], (scoped) => {
      try {
        if (typeof scoped?.tools?.register !== "function") return;
        const dispose = scoped.tools.register({
          name: "dotnet_skills",
          description:
            "Status and manual update for the .NET skills mirror: a Host row keeps a GitHub .NET skill catalog (default: managedcode/dotnet-skills) in sync with the DSH user skill root on a timer (default every 6 hours). Use action=status to see the last check, next check and what was mirrored; action=sync to force a check now.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["status", "sync"],
                description: "status reports the timer and last result; sync forces one check immediately.",
              },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: "object",
              properties: { report: { type: "string" } },
              required: ["report"],
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: "text", text: typeof value?.report === "string" ? value.report : JSON.stringify(value, null, 2) }];
            },
          },
          async execute(args) {
            if (args?.action === "sync") {
              const result = await updater.run("manual");
              return { report: formatStatus(updater.status(), true) + (result.ok ? "" : `\n\nsync failed: ${result.error ?? result.reason}`) };
            }
            return { report: formatStatus(updater.status(), false) };
          },
        });
        try {
          if (typeof dispose === "function" && typeof scoped.on === "function") scoped.on("dispose", dispose);
        } catch {
          /* disposal is best-effort */
        }
      } catch (error) {
        warn(`could not register the dotnet_skills tool: ${String(error)}`);
      }
    });
  } catch (error) {
    warn(`could not inject the tools service: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * plugin entry
 * ------------------------------------------------------------------ */

export function apply(ctx, config = {}) {
  const warn = (message) => {
    try {
      if (typeof ctx?.logger?.warn === "function") ctx.logger.warn(`[${TAG}] ${message}`);
      else console.warn(`[${TAG}] ${message}`);
    } catch {
      /* logging must never break activation */
    }
  };

  let cfg;
  let updater;
  try {
    cfg = resolveConfig(config);
    updater = createUpdater(cfg, warn);
  } catch (error) {
    warn(`could not start: ${String(error)}`);
    return;
  }

  registerTool(ctx, warn, updater);

  try {
    ctx.effect(() => {
      const handles = [];
      const intervalMs = Math.max(60_000, cfg.intervalHours * 3600_000);
      if (cfg.runOnStart) {
        handles.push(
          setTimeout(() => {
            void updater.run("startup");
          }, Math.max(0, cfg.startDelaySeconds) * 1000),
        );
      }
      handles.push(
        setInterval(() => {
          void updater.run("interval");
        }, intervalMs),
      );
      return () => {
        for (const handle of handles) clearTimeout(handle);
      };
    });
  } catch (error) {
    warn(`could not schedule the timer: ${String(error)}`);
  }
}
