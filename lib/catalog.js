/**
 * Catalog index — what the vendored checkout actually offers.
 *
 * The repository nests skills differently from DSH's one-level discovery:
 *   catalog/<Collection>/<Package>/skills/<name>/SKILL.md   (managedcode/dotnet-skills)
 *   plugins/<plugin>/skills/<name>/SKILL.md                 (dotnet/skills)
 *   skills/<name>/SKILL.md                                  (flat collections)
 *
 * The index is the menu the composer panel shows and the source the injector
 * copies from, so it carries the folder to copy and the cheapest description
 * that still identifies the skill.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SEARCH_ROOTS = ["catalog", "plugins", "skills"];
const MAX_DEPTH = 4;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Site, CLI and vendored snapshots are not skills of this catalog. */
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

/** Minimal frontmatter reader for `name` and `description` (plain, quoted or block). */
export function readFrontmatter(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { name: null, description: null };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text);
  if (match === null) return { name: null, description: null };
  const lines = match[1].split(/\r?\n/u);
  const values = { name: null, description: null };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const keyed = /^([A-Za-z_-]+):\s*(.*)$/u.exec(line);
    if (keyed === null) continue;
    const key = keyed[1];
    if (key !== "name" && key !== "description") continue;
    let value = keyed[2].trim();
    if (value === ">" || value === "|" || value === "") {
      // Block scalar: gather the indented lines that follow.
      const parts = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next];
        if (candidate.trim() !== "" && !/^\s/u.test(candidate)) break;
        parts.push(candidate.trim());
      }
      value = parts.join(" ").trim();
    }
    value = value.replace(/^["']/u, "").replace(/["']$/u, "").trim();
    values[key] = value === "" ? null : value;
  }
  return values;
}

/** Rough catalog cost of one entry, matching the Composer panel's estimate. */
export function tokenCost(description) {
  const length = typeof description === "string" ? Math.min(description.length, 500) : 0;
  return Math.round((length + 40) / 3.6);
}

/**
 * Build the index for one checkout.
 * @returns `{ skills: Array<{name, description, tokens, collection, packageName, dir}> }`
 */
export function buildIndex(checkoutDir) {
  const skills = [];
  const seen = new Set();
  for (const rootName of SEARCH_ROOTS) {
    const root = join(checkoutDir, rootName);
    if (!existsSync(root)) continue;
    const candidates = [];
    collectSkillDirs(root, 0, candidates);
    for (const candidate of candidates) {
      if (!KEBAB.test(candidate.name) || seen.has(candidate.name)) continue;
      const parts = relative(checkoutDir, candidate.dir).split(sep);
      parts.pop();
      parts.shift();
      const segments = parts.filter((part) => part !== "" && part.toLowerCase() !== "skills");
      const frontmatter = readFrontmatter(join(candidate.dir, "SKILL.md"));
      seen.add(candidate.name);
      skills.push({
        name: candidate.name,
        description: frontmatter.description ?? "",
        tokens: tokenCost(frontmatter.description),
        collection: segments[0] ?? rootName,
        packageName: segments.length > 1 ? segments[segments.length - 1] : (segments[0] ?? rootName),
        segments,
        dir: candidate.dir,
      });
    }
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  return { skills };
}

/** Package → skill names, for turning a detected stack into a suggestion list. */
export function packagesOf(skills) {
  const map = new Map();
  for (const skill of skills) {
    const key = skill.packageName;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(skill.name);
  }
  return map;
}
