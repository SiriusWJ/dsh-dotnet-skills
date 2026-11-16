/**
 * Model-backed skill selection.
 *
 * The panel used to map project files to catalog packages with a rule table,
 * which over-suggested on any project with a few common packages. Instead the
 * host asks the *current model* — in the background, on panel open — to pick a
 * small set from the catalog given the project facts and its own judgement.
 *
 * Practically:
 *   - one auxiliary `ctx.llm` request, bounded input, `maxTokens`, and a hard
 *     timeout;
 *   - the answer is parsed tolerantly (fenced JSON, bare array, extra prose);
 *   - the result is cached per (checkout head, project facts) so reopening the
 *     panel costs nothing.
 */
const CACHE_TTL_MS = 30 * 60 * 1000;
const DESCRIPTION_CHARS = 90;
const cache = new Map();

const SYSTEM = [
  "You select .NET skills for a real software project.",
  "You receive (1) facts gathered from the project's files and (2) a catalog of available skills.",
  "Pick the {max} most relevant skills at most — fewer when fewer truly fit, never pad the list.",
  "Rank them by relevance (most relevant first). Prefer framework- and library-specific skills over generic ones, and skip a skill when its package is not referenced or its concern is not visible in the project.",
  'Reply with JSON only, no prose: {"skills":[{"name":"<catalog name>","why":"<at most 12 words>"}]}',
  'Write each "why" in {language}.',
].join("\n");

/** The reasons must match the UI language; names stay exactly as in the catalog. */
const LANGUAGE_NAME = { zh: "Simplified Chinese (简体中文)", en: "English" };

/** Best-effort text extraction from one stream chunk. */
function textOf(chunk) {
  if (chunk === null || typeof chunk !== "object") return "";
  if (typeof chunk.text === "string") return chunk.text;
  if (chunk.delta !== null && typeof chunk.delta === "object" && typeof chunk.delta.text === "string") return chunk.delta.text;
  return "";
}

function promptFor(description, catalog, max) {
  const facts = description.facts;
  const lines = [
    `PROJECT ${description.name} (${description.root})`,
    `projects: ${facts.projects > 0 ? facts.projectNames.join(", ") : "none discovered"}`,
    `target frameworks: ${facts.frameworks.join(", ") || "unknown"}`,
    `packages: ${facts.packages.join(", ") || "none"}`,
    `file mix: ${facts.extensions.map(([extension, count]) => `${extension || "(none)"} ×${count}`).join(", ")}`,
    "",
    `CATALOG (${catalog.length} skills; format "name: description")`,
    ...catalog.map((skill) => `${skill.name}: ${(skill.description || "").slice(0, DESCRIPTION_CHARS)}`),
    "",
    `Return at most ${max} skills, most relevant first, as JSON.`,
  ];
  return lines.join("\n");
}

/** Parse the model's JSON, tolerating fences and stray prose. */
export function parseSelection(text, catalog) {
  const byName = new Map(catalog.map((skill) => [skill.name, skill]));
  const candidate = String(text ?? "").trim();
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  const arrayStart = candidate.indexOf("[");
  const arrayEnd = candidate.lastIndexOf("]");
  const slice = (from, to) => {
    if (from === -1 || to <= from) return null;
    try {
      return JSON.parse(candidate.slice(from, to + 1));
    } catch {
      return null;
    }
  };
  // A bare array starts before the first object brace; try that shape first.
  let payload = arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart) ? slice(arrayStart, arrayEnd) : null;
  if (payload === null) payload = slice(objectStart, objectEnd);
  if (payload === null) payload = slice(arrayStart, arrayEnd);
  const entries = Array.isArray(payload) ? payload : Array.isArray(payload?.skills) ? payload.skills : [];
  const suggested = [];
  const reasons = {};
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : typeof entry?.name === "string" ? entry.name : null;
    if (name === null) continue;
    const resolved = byName.get(name.trim()) ?? byName.get(name.trim().toLowerCase());
    if (resolved === undefined || suggested.includes(resolved.name)) continue;
    suggested.push(resolved.name);
    if (typeof entry?.why === "string" && entry.why.trim() !== "") reasons[resolved.name] = entry.why.trim().slice(0, 120);
  }
  return { suggested, reasons };
}

export function cacheKey(head, description, lang) {
  const facts = description.facts;
  return `${head ?? "?"}|${lang ?? "en"}|${description.root}|${facts.projects}|${facts.frameworks.join(",")}|${facts.packages.join(",")}|${facts.files}`;
}

export function cachedSelection(key) {
  const hit = cache.get(key);
  if (hit === undefined) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

export function forgetSelection(key) {
  cache.delete(key);
}

/**
 * Ask the current model to choose skills for this project.
 * @returns `{ suggested, reasons, model, durationMs, cached }`
 */
export async function selectSkills(ctx, options) {
  const { key, description, catalog, sessionId, head } = options;
  const max = Math.max(1, Math.min(20, Number(options.maxSkills) || 8));
  const timeoutMs = Math.max(5_000, Number(options.timeoutMs) || 45_000);
  const lang = options.lang === "zh" ? "zh" : "en";

  const hit = cachedSelection(key);
  if (hit !== null && options.refresh !== true) return { ...hit, cached: true };

  const llm = typeof ctx?.get === "function" ? ctx.get("llm") : undefined;
  if (llm === null || llm === undefined || typeof llm.prepareCall !== "function") {
    throw new Error("the llm service is not available in this composition");
  }
  const selection = typeof ctx?.get === "function" ? ctx.get("agentDefaultModel")?.currentSelection?.() : undefined;
  const provider = selection?.provider;
  const model = selection?.model;
  if (typeof provider !== "string" || typeof model !== "string") {
    throw new Error("no model route is configured for the panel analysis");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    // A request-only user input (no id/source) is the documented shape for an
    // auxiliary call; the stream yields block-start/text-delta/usage/finish.
    const system = SYSTEM.replace("{max}", String(max)).replace("{language}", LANGUAGE_NAME[lang]);
    const messages = [{ role: "user", content: [{ type: "text", text: promptFor(description, catalog, max) }] }];
    let text = "";
    for await (const chunk of llm.stream({
      provider,
      model,
      system,
      messages,
      maxTokens: 700,
      signal: controller.signal,
    })) {
      text += textOf(chunk);
    }
    const parsed = parseSelection(text, catalog);
    const value = {
      suggested: parsed.suggested.slice(0, max),
      reasons: parsed.reasons,
      model: `${provider}/${model}`,
      head: head ?? null,
      at: Date.now(),
      durationMs: Date.now() - started,
      raw: parsed.suggested.length === 0 ? text.slice(0, 400) : undefined,
    };
    cache.set(key, value);
    return { ...value, cached: false };
  } finally {
    clearTimeout(timer);
  }
}
