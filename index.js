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
import { analyzeProject } from "./lib/detect.js";
import { applyProject, clearProject, injectProject, readInjection, skillsDir } from "./lib/inject.js";
import { formatMatches, searchSkills } from "./lib/search.js";

export const inject = ["tools"];

const TAG = "dsh-dotnet-skills";
const STATE_ROUTE = "/dsh-dotnet-skills/state";
const APPLY_ROUTE = "/dsh-dotnet-skills/apply";
const CLEAR_ROUTE = "/dsh-dotnet-skills/clear";
const GIT_TIMEOUT_MS = 180_000;
const LOG_LIMIT = 30;

const DEFAULTS = {
  repoUrl: "https://github.com/managedcode/dotnet-skills.git",
  branch: "main",
  checkoutDir: "",
  intervalHours: 6,
  runOnStart: true,
  startDelaySeconds: 20,
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

function buildPanel(ctx, updater, cfg, sessionId) {
  const project = resolveProject(ctx, sessionId);
  if (project.error !== undefined) return { ok: false, error: project.error };
  let index;
  try {
    index = updater.index();
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error), project: { root: project.root } };
  }
  const analysis = analyzeProject(project.root);
  const byPackage = new Map();
  for (const skill of index.skills) {
    const list = byPackage.get(skill.packageName) ?? [];
    list.push(skill.name);
    byPackage.set(skill.packageName, list);
  }
  const suggested = [];
  for (const packageName of analysis.packages) {
    const names = byPackage.get(packageName);
    if (names === undefined) continue;
    for (const name of names) if (!suggested.includes(name)) suggested.push(name);
  }
  const injected = Object.keys(readInjection(project.root).skills);
  const byName = new Map(index.skills.map((skill) => [skill.name, skill]));
  const tokensOf = (names) => names.reduce((sum, name) => sum + (byName.get(name)?.tokens ?? 0), 0);
  return {
    ok: true,
    project: { root: project.root, name: analysis.name, skillsDir: skillsDir(project.root), projectScoped: project.root !== project.cwd },
    injected,
    detected: { signals: analysis.signals.map((signal) => ({ id: signal.id, label: signal.label })), stats: analysis.stats },
    suggested,
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
          handler: (request, response) => {
            const url = new URL(request.url ?? STATE_ROUTE, "http://localhost");
            sendJson(response, 200, buildPanel(ctx, updater, cfg, url.searchParams.get("sessionId")));
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
              sendJson(response, 200, { ok: true, project: { root: project.root }, ...result, panel: buildPanel(ctx, updater, cfg, body.sessionId) });
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
              sendJson(response, 200, { ok: true, project: { root: project.root }, ...result, panel: buildPanel(ctx, updater, cfg, body?.sessionId) });
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

function formatStatus(status) {
  const last = status.lastResult;
  return [
    `dotnet skills — checkout refreshed every ${status.intervalHours}h`,
    `repo      : ${status.repoUrl}#${status.branch}`,
    `checkout  : ${status.checkoutDir}`,
    `last sync : ${status.lastCheckAt ?? "never"}${last?.ok === false ? ` (failed: ${last.error})` : ""}`,
    `head      : ${String(last?.head ?? "?").slice(0, 8)}`,
  ].join("\n");
}

function formatPanel(panel) {
  if (panel.ok !== true) return `dotnet skills: ${panel.error}`;
  const lines = [
    `project   : ${panel.project.name}  (${panel.project.root})`,
    `injected  : ${panel.injected.length} skills ≈ ${panel.totals.injected} tokens`,
    `detected  : ${panel.detected.signals.map((signal) => signal.label).join(", ") || "nothing recognised"}`,
    `suggested : ${panel.suggested.length} skills ≈ ${panel.totals.suggested} tokens`,
    "",
    "suggested skills:",
    ...panel.suggested.slice(0, 40).map((name) => `  - ${name}`),
  ];
  if (panel.suggested.length > 40) lines.push(`  … ${panel.suggested.length - 40} more`);
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
            "Report the .NET skill setup for this project. The catalog is not in the session: the composer button lets a human inject a project-wide set, and `dotnet_skills_apply` adds skills on demand. action=status shows the checkout state, analyze lists the detected stack, suggested skills and current injection, sync refreshes the cached catalog now.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["status", "sync", "analyze"] },
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
          async execute(args, exec) {
            const action = args?.action ?? "status";
            const sessionId = exec?.agent?.session?.id ?? null;
            try {
              if (action === "sync") {
                const result = await updater.sync("manual");
                return { report: `${result.ok ? "synced" : `sync failed: ${result.error}`}\n${formatStatus(updater.status())}` };
              }
              if (action === "status") return { report: formatStatus(updater.status()) };
              if (action === "analyze") return { report: formatPanel(buildPanel(ctx, updater, cfg, sessionId)) };
              return { report: `unknown action: ${action}` };
            } catch (error) {
              return { report: `dotnet skills: ${String(error?.message ?? error)}` };
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
 * model tools: search the catalog, apply a selection to the project
 * ------------------------------------------------------------------ */

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_LISTED = 30;

/**
 * `dotnet_skills_find` lists matches; `dotnet_skills_apply` adds chosen names to
 * the project. Searching stays a few lines, and spending a skill's tokens is a
 * deliberate second step that lands in the project catalog.
 */
function registerFindTools(ctx, updater, warn) {
  try {
    ctx.inject(["tools"], (scoped) => {
      try {
        if (typeof scoped?.tools?.register !== "function") return;
        const disposers = [];

        disposers.push(
          scoped.tools.register({
            name: "dotnet_skills_find",
            description:
              "Search the cached .NET skill catalog (200+ skills: MSBuild and builds, EF Core, WinForms/WPF/Blazor/MAUI, testing frameworks, profiling and dumps, migrations, architecture, analyzers) and list the matching skills with a one-line description. The catalog is deliberately NOT in this session, so search it for .NET/C# work before answering from memory, then add what you need with dotnet_skills_apply.",
            parameters: {
              type: "object",
              properties: {
                query: {
                  type: "string",
                  description:
                    'Keywords across skill name, package and description, e.g. "msbuild binlog", "ef core performance", "winforms designer", "xunit migration".',
                },
                limit: {
                  type: "integer",
                  description: "Maximum matches to list (default 12, maximum 50).",
                },
              },
              required: ["query"],
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
              try {
                const index = updater.index();
                const query = String(args?.query ?? "").trim();
                if (query === "") return { report: "dotnet_skills_find needs a `query` (keywords such as \"msbuild binlog\")." };
                return { report: formatMatches(searchSkills(index, query, args?.limit), index.skills.length, query) };
              } catch (error) {
                return { report: `dotnet_skills_find: ${String(error?.message ?? error)}` };
              }
            },
          }),
        );

        disposers.push(
          scoped.tools.register({
            name: "dotnet_skills_apply",
            description:
              "Add .NET skills to the current project so their instructions become available in this project's skill catalog. It appends (it never drops a skill the user injected); `remove` drops specific names. Use it when a task needs deeper .NET/C# guidance than you have: search with dotnet_skills_find, then apply the exact names. The result lists each skill's SKILL.md path for immediate reading, and the skills join the project catalog from the next step.",
            parameters: {
              type: "object",
              properties: {
                skills: {
                  type: "array",
                  items: { type: "string" },
                  description: 'Skill names to add (kebab-case, from dotnet_skills_find), e.g. ["binlog-generation"].',
                },
                remove: {
                  type: "array",
                  items: { type: "string" },
                  description: "Optional skill names to drop from the project injection.",
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
            async execute(args, exec) {
              try {
                const project = resolveProject(ctx, exec?.agent?.session?.id);
                if (project.error !== undefined) return { report: `dotnet_skills_apply: ${project.error}` };
                const clean = (list) =>
                  (Array.isArray(list) ? list : [])
                    .filter((name) => typeof name === "string")
                    .map((name) => name.trim())
                    .filter((name) => name !== "");
                const add = clean(args?.skills);
                const remove = clean(args?.remove);
                const invalid = [...add, ...remove].filter((name) => !SKILL_NAME.test(name));
                if (invalid.length > 0) {
                  return { report: `invalid skill name(s): ${invalid.join(", ")} — names come from dotnet_skills_find.` };
                }
                if (add.length === 0 && remove.length === 0) {
                  return { report: "dotnet_skills_apply needs `skills` to add and/or `remove` to drop." };
                }
                const index = updater.index();
                const known = new Set(index.skills.map((skill) => skill.name));
                const unknown = add.filter((name) => !known.has(name));
                if (unknown.length > 0) {
                  return { report: `unknown skill(s): ${unknown.join(", ")} — search with dotnet_skills_find first.` };
                }
                const result = applyProject(project.root, add, remove, index);
                const directory = join(project.root, ".dsh", "skills");
                const lines = [
                  `project set: ${result.injected.length} skills (${result.added.length} added, ${result.removed.length} removed, ${result.copied} written)`,
                  "",
                  ...result.injected.slice(0, MAX_LISTED).map((name) => `- ${name} → ${join(directory, name, "SKILL.md")}`),
                ];
                if (result.injected.length > MAX_LISTED) lines.push(`… ${result.injected.length - MAX_LISTED} more`);
                lines.push("", "Read a listed SKILL.md now for its instructions, or load it with the skill tool once the project catalog refreshes.");
                return { report: lines.join("\n") };
              } catch (error) {
                return { report: `dotnet_skills_apply: ${String(error?.message ?? error)}` };
              }
            },
          }),
        );

        try {
          if (typeof scoped.on === "function") {
            scoped.on("dispose", () => {
              for (const dispose of disposers) {
                try {
                  if (typeof dispose === "function") dispose();
                } catch {
                  /* disposal is best-effort */
                }
              }
            });
          }
        } catch {
          /* disposal is best-effort */
        }
      } catch (error) {
        warn(`could not register the .NET skill tools: ${String(error)}`);
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
  "For .NET/C# work, search it with `dotnet_skills_find` before answering from memory, using the concrete framework plus symptom (e.g. \"msbuild binlog\", \"ef core query performance\", \"xunit migration\"), then add the exact skill with `dotnet_skills_apply`.",
  "That call appends to the project's injected set — it never removes what the user chose — and returns each skill's SKILL.md path to read; the same skills also join the project catalog from the next step.",
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
  registerFindTools(ctx, updater, warn);
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
