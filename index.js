/**
 * dsh-dotnet-skills — on-demand .NET skills for the project you are working in.
 *
 * Nothing is mirrored globally any more: the vendored checkout is only a cache,
 * and a skill reaches the model when a human injects it for a project. The
 * composer button (client half) opens a panel, the host scans the project,
 * rules map the recognised .NET stack to catalog packages, and the confirmed
 * selection is copied into `<project>/.dsh/skills` — the project skill root DSH
 * already watches — so only sessions in that project see those skills.
 *
 * Responsibilities:
 *   - keep the checkout fresh (git fetch, every 6 hours, no token cost);
 *   - analyse a project's files locally (lib/detect.js);
 *   - copy/prune a selection in the project (lib/inject.js);
 *   - serve the composer panel (routes) and the model's `dotnet_skills` tool.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildIndex } from "./lib/catalog.js";
import { applyProject, clearProject, injectProject, readInjection, skillsDir } from "./lib/inject.js";
import { analysisScope, describeProject, looksLikeDotnet } from "./lib/project.js";
import { cacheKey, selectSkills } from "./lib/select.js";
import { formatMatches, searchSkills } from "./lib/search.js";

export const inject = ["tools"];

const TAG = "dsh-dotnet-skills";
const STATE_ROUTE = "/dsh-dotnet-skills/state";
const APPLY_ROUTE = "/dsh-dotnet-skills/apply";
const CLEAR_ROUTE = "/dsh-dotnet-skills/clear";
const GIT_TIMEOUT_MS = 180_000;
const LOG_LIMIT = 30;
/** Last panel requests, for diagnosing "I clicked refresh and nothing happened". */
const recentPanelRequests = [];
function rememberPanelRequest(entry) {
  recentPanelRequests.push(entry);
  if (recentPanelRequests.length > 10) recentPanelRequests.shift();
}

const DEFAULTS = {
  repoUrl: "https://github.com/managedcode/dotnet-skills.git",
  branch: "main",
  checkoutDir: "",
  intervalHours: 6,
  runOnStart: true,
  startDelaySeconds: 20,
  selectMaxSkills: 10,
  selectTimeoutMs: 45_000,
  gitCommand: "git",
};

/* ------------------------------------------------------------------ *
 * paths and configuration
 * ------------------------------------------------------------------ */

function dshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? "").trim();
  return fromEnv === "" ? join(homedir(), ".dsh") : fromEnv;
}

function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  return {
    ...merged,
    checkoutDir: String(merged.checkoutDir ?? "").trim() || join(dshHome(), "vendor", "dotnet-skills"),
    intervalHours: Math.max(0.05, Number(merged.intervalHours) || DEFAULTS.intervalHours),
    startDelaySeconds: Math.max(0, Number(merged.startDelaySeconds) || 0),
    runOnStart: merged.runOnStart !== false,
    statusPath: join(dshHome(), "dotnet-skills.status.json"),
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
      execFile(
        candidates[index],
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
 * checkout + index cache
 * ------------------------------------------------------------------ */

function createUpdater(cfg, warn) {
  const state = {
    running: false,
    lastCheckAt: null,
    lastResult: null,
    logs: [],
    index: null,
    indexHead: null,
  };

  const log = (line) => {
    state.logs.push(`${new Date().toISOString()} ${line}`);
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
  };

  const head = async (git) => {
    const result = await runGit(git, ["-C", cfg.checkoutDir, "rev-parse", "HEAD"], undefined);
    return result.ok ? result.stdout : null;
  };

  /** Refresh the checkout; never throws. */
  const updater = {
    state,
    async sync(trigger = "interval") {
      if (state.running) return { ok: false, reason: "a sync is already running" };
      state.running = true;
      const git = gitCandidates(cfg.gitCommand);
      const result = { ok: false, trigger, clone: false, recloned: false, head: null, changed: false, error: null };
      try {
        log(`sync (${trigger}) from ${cfg.repoUrl}`);
        if (existsSync(join(cfg.checkoutDir, ".git"))) {
          const origin = await runGit(git, ["-C", cfg.checkoutDir, "remote", "get-url", "origin"], undefined);
          if (!origin.ok || normalizeRemote(origin.stdout) !== normalizeRemote(cfg.repoUrl)) {
            rmSync(cfg.checkoutDir, { recursive: true, force: true });
            result.recloned = true;
            log(`origin changed (${origin.ok ? origin.stdout : "unknown"}), re-cloning`);
          }
        }
        const before = existsSync(join(cfg.checkoutDir, ".git")) ? await head(git) : null;
        if (!existsSync(join(cfg.checkoutDir, ".git"))) {
          mkdirSync(dirname(cfg.checkoutDir), { recursive: true });
          const cloned = await runGit(git, ["clone", "--depth", "1", "--branch", cfg.branch, cfg.repoUrl, cfg.checkoutDir], dirname(cfg.checkoutDir));
          if (!cloned.ok) throw new Error(`git clone failed: ${cloned.stderr || cloned.code}`);
          result.clone = true;
        } else {
          const fetched = await runGit(git, ["-C", cfg.checkoutDir, "fetch", "--depth", "1", "origin", cfg.branch], undefined);
          if (!fetched.ok) throw new Error(`git fetch failed: ${fetched.stderr || fetched.code}`);
          const reset = await runGit(git, ["-C", cfg.checkoutDir, "reset", "--hard", "FETCH_HEAD"], undefined);
          if (!reset.ok) throw new Error(`git reset failed: ${reset.stderr || reset.code}`);
        }
        result.head = await head(git);
        result.changed = result.clone || result.recloned || before !== result.head;
        result.ok = true;
        state.index = null; // the checkout moved: rebuild lazily
        state.lastCheckAt = new Date().toISOString();
        state.lastResult = result;
        log(`ok: head ${String(result.head ?? "?").slice(0, 8)}${result.changed ? " (changed)" : " (unchanged)"}`);
      } catch (error) {
        result.error = String(error?.message ?? error);
        state.lastCheckAt = new Date().toISOString();
        state.lastResult = result;
        log(`failed: ${result.error}`);
        warn(`sync failed: ${result.error}`);
      } finally {
        state.running = false;
      }
      return result;
    },
    /** Catalog index for the current checkout (rebuilt when the head moves). */
    index() {
      if (state.index !== null && state.indexHead === state.lastResult?.head) return state.index;
      if (!existsSync(join(cfg.checkoutDir, "catalog")) && !existsSync(join(cfg.checkoutDir, "plugins"))) {
        throw new Error("the skill catalog is not available yet — run a sync first");
      }
      state.index = buildIndex(cfg.checkoutDir);
      state.indexHead = state.lastResult?.head ?? null;
      return state.index;
    },
    status() {
      return {
        running: state.running,
        lastCheckAt: state.lastCheckAt,
        lastResult: state.lastResult,
        intervalHours: cfg.intervalHours,
        checkoutDir: cfg.checkoutDir,
        repoUrl: cfg.repoUrl,
        branch: cfg.branch,
        logs: state.logs.slice(-8),
      };
    },
  };
  return updater;
}

/* ------------------------------------------------------------------ *
 * project resolution
 * ------------------------------------------------------------------ */

function sessionById(ctx, sessionId) {
  try {
    const store = ctx.get("sessions");
    if (store !== null && store !== undefined && typeof store.get === "function") return store.get(sessionId) ?? null;
  } catch {
    /* no session store in this composition */
  }
  return null;
}

function cwdOf(ctx, session) {
  try {
    const working = ctx.get("workingDirectory");
    if (working !== null && working !== undefined && typeof working.get === "function") {
      const directory = working.get(session);
      if (typeof directory === "string" && directory !== "") return directory;
    }
  } catch {
    /* fall back to the session header */
  }
  const candidate = session?.cwd ?? session?.header?.cwd;
  return typeof candidate === "string" && candidate !== "" ? candidate : null;
}

/** DSH's own project rule: the nearest ancestor that contains `.git`. */
function projectRootOf(cwd) {
  let directory = cwd;
  for (let depth = 0; depth < 40; depth += 1) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return cwd;
}

/**
 * The project a request belongs to.
 * @returns `{ root, cwd }` or `{ error }`
 */
function resolveProject(ctx, sessionId) {
  const session = sessionId === undefined || sessionId === null ? null : sessionById(ctx, sessionId);
  if (session === null) return { error: "no live session for that id" };
  const cwd = cwdOf(ctx, session);
  if (cwd === null) return { error: "this session reports no working directory" };
  return { root: projectRootOf(cwd), cwd };
}

/* ------------------------------------------------------------------ *
 * panel payload
 * ------------------------------------------------------------------ */

/**
 * Assemble the panel payload. The skill suggestion is a background model call
 * (cached per checkout head + project facts); when it fails the panel still
 * lists the whole catalog, it just preselects nothing.
 */
async function buildPanel(ctx, updater, cfg, sessionId, options = {}) {
  const project = resolveProject(ctx, sessionId);
  if (project.error !== undefined) return { ok: false, error: project.error };
  let index;
  try {
    index = updater.index();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), project: { root: project.root } };
  }

  const scope = analysisScope(project.root);
  const description = describeProject(scope);
  const head = updater.state.lastResult?.head ?? null;
  const lang = options.lang === "zh" ? "zh" : "en";
  const key = cacheKey(head, description, lang);
  const injected = Object.keys(readInjection(project.root).skills);
  let suggested = [];
  let reasons = {};
  let analysis = { source: "model", note: "" };
  if (options.refresh !== true && injected.length > 0) {
    // Already chosen: just show the current selection, no model call.
    analysis = { source: "existing", note: "" };
    suggested = injected;
  } else if (!looksLikeDotnet(description)) {
    analysis = { source: "skipped", note: "no .NET traces in this project" };
  } else {
    try {
      const picked = await selectSkills(ctx, {
        key,
        description,
        catalog: index.skills,
        sessionId,
        head,
        lang,
        maxSkills: cfg.selectMaxSkills,
        timeoutMs: cfg.selectTimeoutMs,
        refresh: options.refresh === true,
      });
      suggested = picked.suggested;
      reasons = picked.reasons;
      analysis = {
        source: "model",
        model: picked.model,
        durationMs: picked.durationMs,
        cached: picked.cached === true,
        at: picked.at,
        note: suggested.length === 0 ? "the model returned no usable skill" : "",
      };
    } catch (error) {
      analysis = { source: "unavailable", note: String(error?.message ?? error) };
    }
  }

  const byName = new Map(index.skills.map((skill) => [skill.name, skill]));
  const tokensOf = (names) => names.reduce((sum, name) => sum + (byName.get(name)?.tokens ?? 0), 0);
  return {
    ok: true,
    project: {
      root: project.root,
      name: description.name,
      scope,
      scoped: scope !== project.root,
      skillsDir: skillsDir(project.root),
      projectScoped: project.root !== project.cwd,
    },
    injected,
    detected: {
      signals: description.labels.map((label) => ({ id: label, label })),
      stats: description.facts,
    },
    analysis,
    suggested,
    reasons,
    totals: {
      injected: tokensOf(injected),
      suggested: tokensOf(suggested),
      catalog: tokensOf(index.skills.map((skill) => skill.name)),
    },
    catalog: index.skills.map((skill) => ({
      name: skill.name,
      collection: skill.collection,
      package: skill.packageName,
      tokens: skill.tokens,
      description: skill.description.slice(0, 220),
    })),
    state: updater.status(),
  };
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

function readJsonBody(request) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.trim() === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(null);
      }
    });
    request.on("error", () => resolve(null));
  });
}

function sendJson(response, status, body) {
  try {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  } catch {
    /* the socket may already be gone */
  }
}

/** A POST must be JSON from this page; a cross-site form or a bare script cannot. */
function mutationAllowed(request) {
  const contentType = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!contentType.startsWith("application/json")) return false;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin === "string" && typeof host === "string") {
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function registerRoutes(ctx, updater, cfg, warn) {
  try {
    ctx.inject(["webServer"], (scoped) => {
      try {
        if (typeof scoped?.webServer?.register !== "function") return;
        scoped.webServer.register({
          kind: "exact",
          path: STATE_ROUTE,
          handler: async (request, response) => {
            const url = new URL(request.url ?? STATE_ROUTE, "http://localhost");
            const startedAt = Date.now();
            const refresh = url.searchParams.get("refresh") === "1";
            const lang = url.searchParams.get("lang") === "zh" ? "zh" : "en";
            let panel;
            try {
              panel = await buildPanel(ctx, updater, cfg, url.searchParams.get("sessionId"), { refresh, lang });
            } catch (error) {
              panel = { ok: false, error: String(error?.message ?? error) };
            }
            rememberPanelRequest({
              at: new Date(startedAt).toISOString(),
              refresh,
              lang,
              ms: Date.now() - startedAt,
              ok: panel.ok === true,
              source: panel.analysis?.source ?? null,
              cached: panel.analysis?.cached ?? null,
              suggested: panel.suggested?.length ?? 0,
              error: panel.error ?? panel.analysis?.note ?? null,
            });
            sendJson(response, 200, panel);
          },
        });
        scoped.webServer.register({
          kind: "exact",
          path: APPLY_ROUTE,
          handler: async (request, response) => {
            if (!mutationAllowed(request)) {
              sendJson(response, 403, { ok: false, error: "this change has to come from the DSH window" });
              return;
            }
            const body = await readJsonBody(request);
            if (body === null || typeof body !== "object") {
              sendJson(response, 400, { ok: false, error: "invalid JSON body" });
              return;
            }
            const project = resolveProject(ctx, body.sessionId);
            if (project.error !== undefined) {
              sendJson(response, 409, { ok: false, error: project.error });
              return;
            }
            try {
              const index = updater.index();
              const names = Array.isArray(body.skills) ? body.skills.filter((name) => typeof name === "string") : [];
              const result = injectProject(project.root, names, index);
              sendJson(response, 200, { ok: true, project: { root: project.root }, ...result, panel: await buildPanel(ctx, updater, cfg, body.sessionId, { lang: body.lang === "zh" ? "zh" : "en" }) });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        scoped.webServer.register({
          kind: "exact",
          path: CLEAR_ROUTE,
          handler: async (request, response) => {
            if (!mutationAllowed(request)) {
              sendJson(response, 403, { ok: false, error: "this change has to come from the DSH window" });
              return;
            }
            const body = await readJsonBody(request);
            const project = resolveProject(ctx, body?.sessionId);
            if (project.error !== undefined) {
              sendJson(response, 409, { ok: false, error: project.error });
              return;
            }
            try {
              const result = clearProject(project.root);
              sendJson(response, 200, { ok: true, project: { root: project.root }, ...result, panel: await buildPanel(ctx, updater, cfg, body?.sessionId, { lang: body?.lang === "zh" ? "zh" : "en" }) });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
      } catch (error) {
        warn(`could not register routes: ${String(error)}`);
      }
    });
  } catch (error) {
    warn(`could not inject the web server: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * model tool
 * ------------------------------------------------------------------ */

/** Facts for the model, without spending a second model call inside a tool. */
function formatFacts(ctx, sessionId) {
  const project = resolveProject(ctx, sessionId);
  if (project.error !== undefined) return `dotnet_skills: ${project.error}`;
  const scope = analysisScope(project.root);
  const description = describeProject(scope);
  const injected = Object.keys(readInjection(project.root).skills);
  const facts = description.facts;
  return [
    `project    : ${description.name}  (${project.root})`,
    ...(scope !== project.root ? [`analysed   : ${scope}`] : []),
    `injected   : ${injected.length}${injected.length > 0 ? ` — ${injected.join(", ")}` : ""}`,
    `frameworks : ${facts.frameworks.join(", ") || "unknown"}`,
    `projects   : ${facts.projects}${facts.projectNames.length > 0 ? ` (${facts.projectNames.join(", ")})` : ""}`,
    `packages   : ${facts.packages.slice(0, 15).join(", ") || "none"}${facts.packages.length > 15 ? " …" : ""}`,
    "",
    'Search the catalog with action=find and a query (e.g. "msbuild binlog"), then action=add the names you need.',
    "The composer panel (.net技能) asks the model to preselect a set for this project.",
  ].join("\n");
}


/* ------------------------------------------------------------------ *
 * model tool: find, apply, status, sync
 * ------------------------------------------------------------------ */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_LISTED = 30;

function cleanNames(list) {
  return (Array.isArray(list) ? list : [])
    .filter((name) => typeof name === "string")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

/** action=add / action=remove: mutate the project's injected set. */
function mutateSelection(ctx, updater, args, sessionId, mode) {
  const project = resolveProject(ctx, sessionId);
  if (project.error !== undefined) return `dotnet_skills: ${project.error}`;
  const names = cleanNames(args?.skills);
  const invalid = names.filter((name) => !SKILL_NAME.test(name));
  if (invalid.length > 0) return `invalid skill name(s): ${invalid.join(", ")} — names come from action=find.`;
  if (names.length === 0) return mode === "add" ? "action=add needs `skills`." : "action=remove needs `skills`.";
  const index = updater.index();
  if (mode === "add") {
    const known = new Set(index.skills.map((skill) => skill.name));
    const unknown = names.filter((name) => !known.has(name));
    if (unknown.length > 0) return `unknown skill(s): ${unknown.join(", ")} — search with action=find first.`;
  }
  const result = mode === "add" ? applyProject(project.root, names, [], index) : applyProject(project.root, [], names, index);
  const directory = join(project.root, ".dsh", "skills");
  const lines = [
    mode === "add"
      ? `added ${result.added.length} skill(s) — project set: ${result.injected.length}`
      : `removed ${result.removed.length} skill(s) — project set: ${result.injected.length}`,
  ];
  if (result.protected !== undefined && result.protected.length > 0) {
    lines.push(`kept ${result.protected.length} skill(s) the user injected: ${result.protected.join(", ")}`);
  }
  lines.push("", ...result.injected.slice(0, MAX_LISTED).map((name) => `- ${name} → ${join(directory, name, "SKILL.md")}`));
  if (result.injected.length > MAX_LISTED) lines.push(`… ${result.injected.length - MAX_LISTED} more`);
  if (mode === "add") lines.push("", "Read a listed SKILL.md now for its instructions, or load it with the skill tool once the project catalog refreshes.");
  return lines.join("\n");
}

function registerTool(ctx, updater, cfg, warn) {
  try {
    ctx.inject(["tools"], (scoped) => {
      try {
        if (typeof scoped?.tools?.register !== "function") return;
        const dispose = scoped.tools.register({
          name: "dotnet_skills",
          description:
            "The .NET skill catalog for this project. action=find with `query` searches the cached 200+ skills (MSBuild and builds, EF Core, WinForms/WPF/Blazor/MAUI, testing frameworks, profiling and dumps, migrations, architecture, analyzers); without `query` it reports the project's facts (frameworks, packages, current injection). action=add adds the named skills to the project (never drops the user's picks) so their instructions become readable at the returned paths and they join the project catalog on the next step. action=remove removes only skills this tool added itself — anything the user injected from the composer panel is kept and reported. action=probe runs the panel's model selection once and prints the raw result, for diagnosing what the panel would suggest. The catalog refreshes itself in the background; prefer find before answering .NET/C# work from memory.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["find", "add", "remove", "probe"] },
              query: {
                type: "string",
                description:
                  'For action=find: keywords across skill name, package and description, e.g. "msbuild binlog", "ef core performance". Omit to detect the project stack instead.',
              },
              limit: { type: "integer", description: "For action=find with a query: maximum matches (default 12, maximum 50)." },
              skills: {
                type: "array",
                items: { type: "string" },
                description: "For action=add or action=remove: the skill names (kebab-case, from action=find).",
              },
            },
            required: ["action"],
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
          async execute(args, exec) {
            const action = String(args?.action ?? "find");
            const sessionId = exec?.agent?.session?.id ?? null;
            try {
              if (action === "probe") {
                const panel = await buildPanel(ctx, updater, cfg, sessionId, { refresh: true, lang: "zh" });
                return {
                  report: JSON.stringify(
                    {
                      ok: panel.ok,
                      error: panel.error,
                      analysis: panel.analysis,
                      suggested: panel.suggested,
                      reasons: panel.reasons,
                      totals: panel.totals,
                      recentPanelRequests: recentPanelRequests.slice(-6),
                    },
                    null,
                    2,
                  ),
                };
              }
              if (action === "add" || action === "remove") return { report: mutateSelection(ctx, updater, args, sessionId, action) };
              if (action === "find") {
                const query = String(args?.query ?? "").trim();
                if (query === "") return { report: formatFacts(ctx, sessionId) };
                const index = updater.index();
                return { report: formatMatches(searchSkills(index, query, args?.limit), index.skills.length, query) };
              }
              return { report: `unknown action: ${action}` };
            } catch (error) {
              return { report: `dotnet_skills: ${String(error?.message ?? error)}` };
            }
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
 * prompt section
 * ------------------------------------------------------------------ */

/**
 * One short paragraph: without it the model never looks at the catalog, and
 * with a long one the plugin costs more than the skills it saves.
 */
const PROMPT_SECTION = [
  "## .NET skills on demand",
  "A cached catalog of 200+ .NET skills (MSBuild and builds, EF Core, WinForms/WPF/Blazor/MAUI, testing frameworks, profiling and dumps, migrations, architecture, analyzers) is NOT in this session.",
  "For .NET/C# work, search it with `dotnet_skills` and action=find before answering from memory, using the concrete framework plus symptom (e.g. \"msbuild binlog\", \"ef core query performance\", \"xunit migration\"); omit the query to detect the project's stack instead.",
  "Then add the exact names with `dotnet_skills` and action=add — it appends to the project's injected set and returns each SKILL.md path to read; the same skills join the project catalog on the next step.",
  "action=remove only removes skills this tool added itself; a skill the user injected from the `.net技能` panel is protected and reported back.",
  "Do this whenever a task needs the depth, even if the user never opened the `.net技能` panel. Remove or clear skills only when the user asks.",
].join("\n");

function registerPromptSection(ctx, warn) {
  try {
    if (typeof ctx?.systemPrompt?.section !== "function") return;
    ctx.effect(
      () => ctx.systemPrompt.section({ name: "dsh-dotnet-skills:catalog", order: 176, text: PROMPT_SECTION }),
      "dsh-dotnet-skills: prompt section",
    );
  } catch (error) {
    warn(`could not add the prompt section: ${String(error)}`);
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

  registerRoutes(ctx, updater, cfg, warn);
  registerTool(ctx, updater, cfg, warn);
  registerPromptSection(ctx, warn);

  try {
    ctx.effect(() => {
      const handles = [];
      const intervalMs = Math.max(60_000, cfg.intervalHours * 3600_000);
      if (cfg.runOnStart) {
        handles.push(
          setTimeout(() => {
            void updater.sync("startup");
          }, Math.max(0, cfg.startDelaySeconds) * 1000),
        );
      }
      handles.push(
        setInterval(() => {
          void updater.sync("interval");
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
