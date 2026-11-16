/**
 * Catalog search — the model's side of the on-demand skills.
 *
 * The catalog stays out of the session context on purpose (203 skills ≈ 25k
 * tokens of catalog). `dotnet_skills_find` searches it and returns only the few
 * entries that match, and `dotnet_skills_load` hands over one skill's
 * instructions, so the model pulls expertise in a step instead of paying for
 * the whole index.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_BODY = 60 * 1024;

function scoreEntry(skill, terms) {
  const name = skill.name.toLowerCase();
  const packageName = skill.packageName.toLowerCase();
  const description = skill.description.toLowerCase();
  const haystack = `${name} ${packageName} ${description}`;
  for (const term of terms) if (!haystack.includes(term)) return 0;
  let score = 0;
  for (const term of terms) {
    if (name === term) score += 120;
    else if (name.startsWith(term)) score += 70;
    else if (name.includes(term)) score += 50;
    if (packageName.includes(term)) score += 25;
    if (description.includes(term)) score += 12;
  }
  return score;
}

/**
 * Search the index.
 * @returns Array of `{name, package, tokens, description, score}` best first.
 */
export function searchSkills(index, query, limit) {
  const terms = String(query ?? "")
    .toLowerCase()
    .split(/\s+/u)
    .map((term) => term.trim())
    .filter((term) => term !== "");
  if (terms.length === 0) return [];
  return index.skills
    .map((skill) => ({ skill, score: scoreEntry(skill, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.skill.tokens - right.skill.tokens)
    .slice(0, Math.max(1, Math.min(50, Number(limit) || 12)))
    .map((entry) => ({
      name: entry.skill.name,
      package: entry.skill.packageName,
      collection: entry.skill.collection,
      tokens: entry.skill.tokens,
      description: entry.skill.description,
      score: entry.score,
    }));
}

function stripFrontmatter(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(text);
  return match === null ? text : text.slice(match[0].length);
}

/**
 * Load one skill's instructions by exact name.
 * @returns `{ ok: true, body, dir }` or `{ ok: false, error }`
 */
export function loadSkill(index, name) {
  const wanted = String(name ?? "").trim();
  const skill = index.skills.find((entry) => entry.name === wanted);
  if (skill === undefined) {
    const near = index.skills
      .filter((entry) => entry.name.includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(entry.name))
      .slice(0, 5)
      .map((entry) => entry.name);
    return {
      ok: false,
      error: `unknown skill "${wanted}"${near.length > 0 ? ` — did you mean: ${near.join(", ")}?` : ""}`,
    };
  }
  let body = "";
  try {
    body = readFileSync(join(skill.dir, "SKILL.md"), "utf8");
  } catch (error) {
    return { ok: false, error: `could not read ${skill.name}: ${String(error?.message ?? error)}` };
  }
  const trimmed = stripFrontmatter(body).trim();
  const capped = trimmed.length > MAX_BODY ? `${trimmed.slice(0, MAX_BODY)}\n\n[truncated at ${MAX_BODY} bytes]` : trimmed;
  return { ok: true, body: capped, dir: skill.dir, skill };
}

/** Human-readable search result for a tool result: name + one-line description. */
export function formatMatches(matches, total, query) {
  if (matches.length === 0) {
    return `No .NET skill matched "${query}" (catalog: ${total}). Try broader keywords such as "msbuild", "ef core", "winforms", "blazor", "testing", "profiling".`;
  }
  const lines = [`${matches.length} of ${total} catalog skills matched "${query}":`, ""];
  for (const match of matches) {
    lines.push(`- \`${match.name}\`${briefOf(match.description)}`);
  }
  lines.push("", "Load one with `dotnet_skills_load` and `name: \"<skill-name>\"`. Human-facing injection is the composer button.");
  return lines.join("\n");
}

/** First sentence, word-bounded and capped, so one entry stays one line. */
function briefOf(description) {
  const text = String(description ?? "").replace(/\s+/gu, " ").trim();
  if (text === "") return "";
  const sentence = /^(.*?[.!?])(?=\s|$)/u.exec(text)?.[1] ?? text;
  const capped = sentence.length > 160 ? `${sentence.slice(0, 157).replace(/[\s,;:.\-]+$/u, "")}…` : sentence;
  return ` — ${capped}`;
}
