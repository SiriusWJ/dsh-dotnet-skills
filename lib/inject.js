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
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MANIFEST_NAME = "dotnet-skills.json";
const SKILLS_DIR = "skills";
const CATALOG_PARTS = ["Skills", "DotnetSkills"];
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

/** The managed repository: `<project>/.dsh/Skills/DotnetSkills`. */
export function catalogDir(projectRoot) {
  return join(stateDir(projectRoot), ...CATALOG_PARTS);
}

/** Is `path` a link rather than a real directory? */
function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Drop one skill directory: a real copy, or a link left by an older layout. */
function removeEntry(path) {
  if (!existsSync(path) && !isLink(path)) return false;
  if (isLink(path)) {
    try {
      withRetry(() => unlinkSync(path));
    } catch {
      withRetry(() => rmSync(path, { recursive: true, force: true }));
    }
    return true;
  }
  withRetry(() => rmSync(path, { recursive: true, force: true }));
  return true;
}

/**
 * Copy one skill into the project twice, which is what the layout asks for.
 *
 * 1. `<project>/.dsh/Skills/DotnetSkills/<name>` — the managed repository this
 *    plugin owns and rewrites on every catalog update;
 * 2. `<project>/.dsh/skills/<name>` — the flat copy DSH discovers, because the
 *    provider reads skill roots one level deep only (`<root>/<name>/SKILL.md`).
 *
 * The second copy is made from the first, so both always agree even when the
 * catalog checkout disappears later.
 */
function writeSkill(projectRoot, name, sourceDir) {
  const repository = join(catalogDir(projectRoot), name);
  mergeCopy(sourceDir, repository);
  mergeCopy(repository, join(skillsDir(projectRoot), name));
}

/** Both copies exist and hold a SKILL.md? */
function isPresent(projectRoot, name) {
  return existsSync(join(catalogDir(projectRoot), name, "SKILL.md")) && existsSync(join(skillsDir(projectRoot), name, "SKILL.md"));
}

/** Remove one skill from both copies. */
function removeSkill(projectRoot, name) {
  const fromSkills = removeEntry(join(skillsDir(projectRoot), name));
  const fromCatalog = removeEntry(join(catalogDir(projectRoot), name));
  return fromSkills || fromCatalog;
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
    if (existing !== undefined && existing.fingerprint === prints && isPresent(projectRoot, name)) {
      unchanged += 1;
      continue;
    }
    writeSkill(projectRoot, name, skill.dir);
    copied += 1;
  }

  let pruned = 0;
  for (const stale of Object.keys(previous.skills)) {
    if (Object.prototype.hasOwnProperty.call(next, stale)) continue;
    if (removeSkill(projectRoot, stale)) pruned += 1;
  }

  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 3, skills: next }, null, 2)}\n`, "utf8");
  ensureGitExclude(projectRoot);
  return { injected: selected, copied, pruned, unchanged };
}

/** Remove everything this plugin injected into the project. */
export function clearProject(projectRoot) {
  const previous = readInjection(projectRoot);
  let pruned = 0;
  for (const name of Object.keys(previous.skills)) {
    if (removeSkill(projectRoot, name)) pruned += 1;
  }
  writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 3, skills: {} }, null, 2)}\n`, "utf8");
  return { pruned };
}

/**
 * Re-copy the project's injected skills from a refreshed catalog.
 *
 * The background checkout sync calls this after a fetch, so a project that was
 * filled in earlier picks up the new skill bodies without anyone reopening the
 * panel. Skills that disappeared upstream are dropped; fingerprints choose what
 * to rewrite.
 */
export function syncProjectSkills(projectRoot, index) {
  const previous = readInjection(projectRoot);
  const byName = new Map(index.skills.map((skill) => [skill.name, skill]));
  const next = {};
  let updated = 0;
  let unchanged = 0;
  let dropped = 0;
  for (const [name, entry] of Object.entries(previous.skills)) {
    const skill = byName.get(name);
    if (skill === undefined) {
      if (removeSkill(projectRoot, name)) dropped += 1;
      continue;
    }
    const prints = fingerprint(skill.dir);
    next[name] = { ...entry, fingerprint: prints };
    if (entry.fingerprint === prints && isPresent(projectRoot, name)) {
      unchanged += 1;
      continue;
    }
    writeSkill(projectRoot, name, skill.dir);
    updated += 1;
  }
  if (updated > 0 || dropped > 0) {
    writeFileSync(manifestPath(projectRoot), `${JSON.stringify({ version: 3, skills: next }, null, 2)}\n`, "utf8");
  }
  return { updated, unchanged, dropped };
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

/** Whether this project asked for the Microsoft Learn MCP server (per working directory). */
export function readLearnMcp(projectRoot) {
  try {
    const raw = JSON.parse(readFileSync(manifestPath(projectRoot), "utf8"));
    return raw !== null && typeof raw === "object" && raw.learnMcp === true;
  } catch {
    return false;
  }
}

/** Record the project's choice, keeping the skill entries that are already there. */
export function setLearnMcp(projectRoot, enabled) {
  let raw = {};
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(projectRoot), "utf8"));
    if (parsed !== null && typeof parsed === "object") raw = parsed;
  } catch {
    /* first write for this project */
  }
  const skills = raw.skills !== null && typeof raw.skills === "object" ? raw.skills : {};
  mkdirSync(stateDir(projectRoot), { recursive: true });
  writeFileSync(
    manifestPath(projectRoot),
    `${JSON.stringify({ ...raw, version: 2, skills, learnMcp: enabled === true }, null, 2)}\n`,
    "utf8",
  );
  return enabled === true;
}

export { MANIFEST_NAME };
