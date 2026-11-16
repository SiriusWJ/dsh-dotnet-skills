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

/** What this plugin injected into the project (empty when it never ran). */
export function readInjection(projectRoot) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(projectRoot), "utf8"));
    if (raw !== null && typeof raw === "object" && raw.skills !== null && typeof raw.skills === "object") {
      return { skills: raw.skills };
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
 * @returns `{ injected: string[], copied: number, pruned: number, unchanged: number }`
 */
export function injectProject(projectRoot, names, index) {
  const byName = new Map(index.skills.map((skill) => [skill.name, skill]));
  const previous = readInjection(projectRoot);
  const target = skillsDir(projectRoot);
  const selected = [];
  let copied = 0;
  let unchanged = 0;
  const next = {};

  mkdirSync(target, { recursive: true });

  for (const name of [...new Set(names)].sort()) {
    const skill = byName.get(name);
    if (skill === undefined) continue;
    const destination = join(target, name);
    const prints = fingerprint(skill.dir);
    next[name] = { fingerprint: prints };
    selected.push(name);
    const owned = Object.prototype.hasOwnProperty.call(previous.skills, name);
    if (owned && previous.skills[name]?.fingerprint === prints && existsSync(join(destination, "SKILL.md"))) {
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

  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 1, skills: next }, null, 2)}\n`, "utf8");
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
  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 1, skills: {} }, null, 2)}\n`, "utf8");
  return { pruned };
}

/**
 * Add skills to whatever the project already has (model-facing semantics: never
 * drops a skill the human injected), optionally dropping names in `remove`.
 * @returns the `injectProject` result plus `added`/`removed`.
 */
export function applyProject(projectRoot, add, remove, index) {
  const existing = Object.keys(readInjection(projectRoot).skills);
  const removing = new Set(Array.isArray(remove) ? remove : []);
  const keep = existing.filter((name) => !removing.has(name));
  const adding = (Array.isArray(add) ? add : []).filter((name) => !removing.has(name));
  const merged = [...keep];
  const added = [];
  for (const name of adding) {
    if (merged.includes(name)) continue;
    merged.push(name);
    added.push(name);
  }
  const removed = existing.filter((name) => removing.has(name));
  const result = injectProject(projectRoot, merged, index);
  return { ...result, added, removed };
}

export { MANIFEST_NAME };
