/**
 * Project injection — copy selected skills into `<project>/.dsh/skills`.
 *
 * DSH discovers a project's skills at `<projectRoot>/.dsh/skills/<name>/SKILL.md`
 * (rank 100, ahead of the user root), so a project-scoped injection reaches every
 * session working in that project and no other. Nothing global is written; the
 * vendored checkout stays the single source of truth.
 *
 * The manifest at `<project>/.dsh/dotnet-skills.json` records what this plugin
 * owns in that project, so clearing the set never deletes a hand-written skill.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_NAME = "dotnet-skills.json";
const SKILLS_DIR = "skills";
const GIT_BLOCK_BEGIN = "# >>> dsh-dotnet-skills (project injection) >>>";
const GIT_BLOCK_END = "# <<< dsh-dotnet-skills <<<";

/** Transient Windows failures: the skill watcher or a scanner holds a handle. */
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

/** Directory fingerprint, so an unchanged skill is not rewritten on every open. */
export function fingerprint(directory) {
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

/** Overwrite in place; deleting the directory first trips the watcher on Windows. */
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
    withRetry(() => rmSync(join(target, entry.name), { recursive: true, force: true }));
  }
}

function stateDir(projectRoot) {
  return join(projectRoot, ".dsh");
}

export function skillsDir(projectRoot) {
  return join(stateDir(projectRoot), SKILLS_DIR);
}

function manifestPath(projectRoot) {
  return join(stateDir(projectRoot), MANIFEST_NAME);
}

/**
 * What this plugin injected into the project (empty when it never ran).
 *
 * Every entry records who injected it: `user` (composer panel) or `model`
 * (dotnet_skills action=add). Only model-owned entries may be removed by the
 * model, so a human's selection survives an agent that changes its mind.
 */
export function readInjection(projectRoot) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(projectRoot), "utf8"));
    if (raw !== null && typeof raw === "object" && raw.skills !== null && typeof raw.skills === "object") {
      const skills = {};
      for (const [name, value] of Object.entries(raw.skills)) {
        const entry = value !== null && typeof value === "object" ? value : {};
        skills[name] = { fingerprint: entry.fingerprint ?? null, source: entry.source === "model" ? "model" : "user" };
      }
      return { skills };
    }
  } catch {
    /* no injection yet */
  }
  return { skills: {} };
}

/** Keep the project's git status clean without touching its tracked .gitignore. */
function ensureGitExclude(projectRoot) {
  const gitDir = join(projectRoot, ".git");
  if (!existsSync(gitDir)) return;
  const excludePath = join(gitDir, "info", "exclude");
  let kept = [];
  if (existsSync(excludePath)) {
    let skipping = false;
    for (const line of readFileSync(excludePath, "utf8").split(/\r?\n/u)) {
      if (line === GIT_BLOCK_BEGIN) {
        skipping = true;
        continue;
      }
      if (line === GIT_BLOCK_END) {
        skipping = false;
        continue;
      }
      if (!skipping) kept.push(line);
    }
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  mkdirSync(join(gitDir, "info"), { recursive: true });
  writeFileSync(excludePath, [...kept, "", GIT_BLOCK_BEGIN, "/.dsh/", GIT_BLOCK_END].join("\n") + "\n", "utf8");
}

/**
 * Apply a selection to the project: copy new/changed skills, prune unselected
 * ones this plugin owns, and record the result.
 * @param options.source - `user` (panel) or `model` (tool); recorded per entry
 *   and preserved for skills that were already there.
 * @returns `{ injected: string[], copied, pruned, unchanged }`
 */
export function injectProject(projectRoot, names, index, options = {}) {
  const byName = new Map(index.skills.map((skill) => [skill.name, skill]));
  const previous = readInjection(projectRoot);
  const target = skillsDir(projectRoot);
  const selected = [];
  let copied = 0;
  let unchanged = 0;
  const next = {};
  const source = options.source === "model" ? "model" : "user";

  mkdirSync(target, { recursive: true });

  for (const name of [...new Set(names)].sort()) {
    const skill = byName.get(name);
    if (skill === undefined) continue;
    const destination = join(target, name);
    const prints = fingerprint(skill.dir);
    const existing = previous.skills[name];
    next[name] = {
      fingerprint: prints,
      // The panel expresses the human's decision, so everything it saves becomes
      // user-owned. A model add preserves the existing owner and marks its own.
      source: existing !== undefined && source !== "user" ? existing.source : source,
    };
    selected.push(name);
    if (existing !== undefined && existing.fingerprint === prints && existsSync(join(destination, "SKILL.md"))) {
      unchanged += 1;
      continue;
    }
    mergeCopy(skill.dir, destination);
    copied += 1;
  }

  let pruned = 0;
  for (const stale of Object.keys(previous.skills)) {
    if (Object.prototype.hasOwnProperty.call(next, stale)) continue;
    const destination = join(target, stale);
    if (existsSync(destination)) {
      withRetry(() => rmSync(destination, { recursive: true, force: true }));
      pruned += 1;
    }
  }

  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 2, skills: next }, null, 2)}\n`, "utf8");
  ensureGitExclude(projectRoot);
  return { injected: selected, copied, pruned, unchanged };
}

/** Remove everything this plugin injected into the project. */
export function clearProject(projectRoot) {
  const previous = readInjection(projectRoot);
  const target = skillsDir(projectRoot);
  let pruned = 0;
  for (const name of Object.keys(previous.skills)) {
    const destination = join(target, name);
    if (!existsSync(destination)) continue;
    withRetry(() => rmSync(destination, { recursive: true, force: true }));
    pruned += 1;
  }
  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 2, skills: {} }, null, 2)}\n`, "utf8");
  return { pruned };
}

/**
 * Model-facing: add skills, and remove only the skills the model added itself.
 *
 * A skill the human injected from the composer panel stays, even when the model
 * asks to remove it — it reports the protected names back instead.
 * @returns the `injectProject` result plus `added`/`removed`/`protected`.
 */
export function applyProject(projectRoot, add, remove, index) {
  const previous = readInjection(projectRoot);
  const existing = Object.keys(previous.skills);
  const requested = new Set(Array.isArray(remove) ? remove : []);
  const removable = existing.filter((name) => requested.has(name) && previous.skills[name]?.source === "model");
  const protectedNames = existing.filter((name) => requested.has(name) && previous.skills[name]?.source !== "model");
  const keep = existing.filter((name) => !removable.includes(name));
  const merged = [...keep];
  for (const name of Array.isArray(add) ? add : []) if (!merged.includes(name)) merged.push(name);
  const result = injectProject(projectRoot, merged, index, { source: "model" });
  const added = (Array.isArray(add) ? add : []).filter((name) => !existing.includes(name));
  return { ...result, added, removed: removable, protected: protectedNames };
}

export { MANIFEST_NAME };
