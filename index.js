/**
 * dsh-dotnet-skills — project-scoped .NET skills, picked by the current model.
 *
 * Nothing is mirrored globally: the vendored checkout is only a cache. Opening
 * the composer panel reads the project's facts locally, asks the model to choose
 * from the catalog, and copies the confirmed selection into the project twice
 * (`.dsh/Skills/DotnetSkills` as the managed repository, `.dsh/skills` as the
 * flat copy DSH discovers), so only sessions in that project see those skills.
 *
 * Responsibilities:
 *   - keep the checkout fresh (git fetch on a timer, no token cost) and refresh
 *     the projects that already injected skills when the head moves;
 *   - gather facts from a project's files (lib/project.js);
 *   - ask the model to pick, cached per head + facts + language (lib/select.js);
 *   - inject and prune per project, with ownership recorded per skill
 *     (lib/inject.js);
 *   - mount the public Microsoft Learn MCP server for projects that ask for it.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Schema from "@deepseek-ai/schemastery";
import { buildIndex } from "./lib/catalog.js";
import { applyProject, catalogDir, clearProject, injectProject, readInjection, readLearnMcp, setLearnMcp, skillsDir, syncProjectSkills } from "./lib/inject.js";
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
/** Set by apply(): re-copy project skills after the checkout moved. */
let afterCatalogSync = null;
/** Route-registration failures, surfaced by action=probe. */
const routeErrors = [];
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

/* ------------------------------------------------------------------ *
 * configuration (edited from Plugins → Installed)
 * ------------------------------------------------------------------ */

/** Offered refresh intervals, in hours. */
const INTERVAL_OPTIONS = [6, 12, 24, 72, 168];
const SETTINGS_ROUTE = "/dsh-dotnet-skills/settings";
const COUNT_ROUTE = "/dsh-dotnet-skills/count";
const LEARN_ROUTE = "/dsh-dotnet-skills/learn";
const MAX_SKILLS_LIMIT = 50;
const MIN_SKILLS_LIMIT = 1;

/**
 * The row config the Plugin Manager renders as a form. Both knobs are bounded
 * here, so a hand-edited patch file cannot put the plugin in a silly state.
 */
export const Config = Schema.object({
  intervalHours: Schema.union(INTERVAL_OPTIONS.map((hours) => Schema.const(hours)))
    .default(6)
    .description("How often the skill catalog is refreshed: 6 h / 12 h / 1 day / 3 days / 1 week."),
  selectMaxSkills: Schema.number()
    .min(MIN_SKILLS_LIMIT)
    .max(MAX_SKILLS_LIMIT)
    .step(1)
    .default(10)
    .description("How many skills the model may pick for a project (1–50)."),
  repoUrl: Schema.string().default(DEFAULTS.repoUrl).description("Catalog repository, managedcode/dotnet-skills by default."),
  branch: Schema.string().default(DEFAULTS.branch).description("Branch of the catalog repository to track."),
  runOnStart: Schema.boolean().default(true).description("Refresh the catalog shortly after DSH starts."),
  checkoutDir: Schema.string().default("").description("Where the catalog checkout lives; empty means $DSH_HOME/vendor/dotnet-skills."),
  startDelaySeconds: Schema.number().min(0).step(1).default(20).description("Delay before the startup refresh."),
  selectTimeoutMs: Schema.number().min(5000).step(1000).default(45_000).description("Timeout of one panel analysis (ms)."),
});

function intervalLabel(hours) {
  if (hours >= 168) return "1 week";
  if (hours >= 72) return `${Math.round(hours / 24)} days`;
  if (hours >= 24) return "1 day";
  return `${hours} h`;
}

/** Read-only view of the active configuration, for the panel footer. */
function settingsView(cfg) {
  return {
    intervalHours: cfg.intervalHours,
    intervalLabel: intervalLabel(cfg.intervalHours),
    intervalOptions: INTERVAL_OPTIONS.map((hours) => ({ hours, label: intervalLabel(hours) })),
    selectMaxSkills: cfg.selectMaxSkills,
    minSkills: MIN_SKILLS_LIMIT,
    maxSkills: MAX_SKILLS_LIMIT,
    learn,
  };
}

function resolveConfig(config) {
  const merged = { ...DEFAULTS, ...(config ?? {}) };
  return {
    ...merged,
    checkoutDir: String(merged.checkoutDir ?? "").trim() || join(dshHome(), "vendor", "dotnet-skills"),
    intervalHours: INTERVAL_OPTIONS.includes(Number(merged.intervalHours)) ? Number(merged.intervalHours) : DEFAULTS.intervalHours,
    selectMaxSkills: Math.min(MAX_SKILLS_LIMIT, Math.max(MIN_SKILLS_LIMIT, Math.round(Number(merged.selectMaxSkills)) || DEFAULTS.selectMaxSkills)),
    startDelaySeconds: Math.max(0, Number(merged.startDelaySeconds) || 0),
    runOnStart: merged.runOnStart !== false,
    statusPath: join(dshHome(), "dotnet-skills.status.json"),
  };
}

/* ------------------------------------------------------------------ *
 * Microsoft Learn: MCP server (streamable HTTP) + the mslearn CLI
 * ------------------------------------------------------------------ */

const LEARN_MCP_URL = "https://learn.microsoft.com/api/mcp";
/** Projects that turned the server on; the server is mounted while this is not empty. */
const learnProjects = new Set();
let mcpFiber = null;
const LEARN_CLI_PACKAGE = "@microsoft/learn-cli";
/** Live state of both integrations, reported to the panel. */
const learn = {
  mcp: { active: false, url: LEARN_MCP_URL, error: null, projects: [] },
  cli: { enabled: false, installed: null, busy: false, package: LEARN_CLI_PACKAGE, log: [] },
};

/** Locate the installed MCP client package: beside this build, or inside the running app's resources. */
function mcpClientEntry() {
  const roots = [];
  const fromEnv = String(process.env.DSH_INSTALL_DIR ?? "").trim();
  if (fromEnv !== "") roots.push(dirname(fromEnv));
  const resources = String(process.resourcesPath ?? "").trim() || join(dirname(process.execPath), "resources");
  for (const carrier of ["app.asar", "app"]) roots.push(join(resources, carrier, "dsh", "node_modules", "@deepseek-ai"));
  const candidates = [];
  for (const root of roots) {
    for (const entry of ["lib/index.js", "index.js"]) candidates.push(join(root, "dsh-mcp-client", entry));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Roots whose project asked for the server, kept across restarts. */
/** Projects this plugin wrote into, so a catalog update can refresh them. */
function projectsPath() {
  return join(dshHome(), "dotnet-skills.projects.json");
}

function knownProjects() {
  try {
    const list = JSON.parse(readFileSync(projectsPath(), "utf8"));
    return Array.isArray(list) ? list.filter((root) => typeof root === "string" && existsSync(root)) : [];
  } catch {
    return [];
  }
}

function rememberProject(projectRoot) {
  const roots = knownProjects();
  if (roots.includes(projectRoot)) return;
  roots.push(projectRoot);
  try {
    writeFileSync(projectsPath(), `${JSON.stringify(roots, null, 2)}\\n`, "utf8");
  } catch {
    /* the in-memory path still works for this run */
  }
}

/** Refresh every project this plugin filled, after the checkout moved. */
function syncKnownProjects(updater, warn) {
  let index;
  try {
    index = updater.index();
  } catch (error) {
    warn(`could not rebuild the catalog index: ${String(error?.message ?? error)}`);
    return;
  }
  for (const root of knownProjects()) {
    try {
      const result = syncProjectSkills(root, index);
      if (result.updated > 0 || result.dropped > 0) {
        warn(`refreshed ${root}: ${result.updated} skill(s) updated, ${result.dropped} dropped`);
      }
    } catch (error) {
      warn(`could not refresh ${root}: ${String(error?.message ?? error)}`);
    }
  }
}

function learnStatePath() {
  return join(dshHome(), "dotnet-skills.learn.json");
}

function knownLearnProjects() {
  try {
    const list = JSON.parse(readFileSync(learnStatePath(), "utf8"));
    if (!Array.isArray(list)) return [];
    return list.filter((root) => typeof root === "string" && readLearnMcp(root));
  } catch {
    return [];
  }
}

function saveLearnProjects() {
  try {
    writeFileSync(learnStatePath(), `${JSON.stringify([...learnProjects], null, 2)}\n`, "utf8");
  } catch {
    /* the in-memory set still works for this run */
  }
}

/** Track one project's flag and keep the server in step with the set. */
async function registerLearnProject(ctx, warn, root) {
  if (readLearnMcp(root)) learnProjects.add(root);
  else learnProjects.delete(root);
  saveLearnProjects();
  await reconcileLearnMcp(ctx, warn);
}

/** Mount @deepseek-ai/dsh-mcp-client as a child plugin while any project asks for it. */
async function mountLearnMcp(ctx, warn) {
  try {
    const entryPath = mcpClientEntry();
    if (entryPath === null) throw new Error("the MCP client package is not installed beside this DSH build");
    const loaded = await import(pathToFileURL(entryPath).href);
    const plugin = loaded.default ?? loaded;
    const fiber = ctx.plugin(plugin, {
      serverName: "microsoft-learn-cli",
      transport: "streamable-http",
      url: LEARN_MCP_URL,
      failOnStartupError: false,
    });
    learn.mcp.active = true;
    learn.mcp.error = null;
    return fiber ?? null;
  } catch (error) {
    learn.mcp.active = false;
    learn.mcp.error = String(error?.message ?? error);
    warn(`could not start the Microsoft Learn MCP server: ${learn.mcp.error}`);
    return null;
  }
}

/**
 * Keep the server mounted exactly while some project has it on: the choice is
 * per working directory, so the process-wide server follows the project set.
 */
async function reconcileLearnMcp(ctx, warn) {
  learn.mcp.projects = [...learnProjects];
  const wanted = learnProjects.size > 0;
  if (wanted && mcpFiber === null) {
    mcpFiber = await mountLearnMcp(ctx, warn);
    if (mcpFiber !== null) ensureLearnCli(warn);
    return;
  }
  if (!wanted && mcpFiber !== null) {
    try {
      mcpFiber.dispose();
    } catch {
      /* an already-disposed fiber is fine */
    }
    mcpFiber = null;
    learn.mcp.active = false;
    learn.mcp.error = null;
  }
}

/** Persist this row's configuration through the config editor, which restarts the plugin. */
async function saveConfig(ctx, patch) {
  const editor = typeof ctx.get === "function" ? ctx.get("configEditor") : undefined;
  const entry = ctx.fiber?.entry;
  if (editor === undefined || typeof editor.edit !== "function") throw new Error("configuration cannot be saved in this profile");
  if (entry === undefined) throw new Error("the plugin entry is not addressable");
  await editor.edit(entry, (current) => ({ ...(current ?? {}), ...patch }));
}

/** Run the npm `args`; Windows needs cmd.exe because execFile cannot spawn a .cmd file. */
function runNpm(args, options, done) {
  try {
    if (process.platform === "win32") {
      execFile(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm", ...args], options, done);
    } else {
      execFile("npm", args, options, done);
    }
  } catch (error) {
    done(error, "", "");
  }
}

/**
 * Keep the `mslearn` CLI available whenever the MCP server is on: detect an
 * existing global install first, install it only when it is missing.
 */
function ensureLearnCli(warn) {
  learn.cli.enabled = learn.mcp.active === true;
  if (!learn.cli.enabled) return;
  if (learn.cli.busy) return;
  if (learn.cli.installed === true) return;
  learn.cli.busy = true;
  const install = () => {
    runNpm(["install", "-g", LEARN_CLI_PACKAGE], { timeout: 240_000, windowsHide: true }, (error, stdout, stderr) => {
      learn.cli.busy = false;
      learn.cli.installed = error === null;
      const output = `${stdout ?? ""}${stderr ?? ""}`.trim().split(/\r?\n/u).filter((line) => line !== "");
      learn.cli.log = error === null ? output.slice(-2) : [...output.slice(-5), String(error.message ?? error)].slice(-6);
      if (error !== null) warn(`could not install ${LEARN_CLI_PACKAGE}: ${error.message}`);
    });
  };
  runNpm(["ls", "-g", LEARN_CLI_PACKAGE, "--depth=0"], { timeout: 60_000, windowsHide: true }, (error) => {
    if (error === null) {
      learn.cli.busy = false;
      learn.cli.installed = true;
      return;
    }
    install();
  });
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
        if (result.changed && typeof afterCatalogSync === "function") {
          // Projects that already injected skills pick up the new bodies here.
          try {
            await afterCatalogSync();
          } catch (error) {
            warn(`could not refresh the project skills after the catalog sync: ${String(error?.message ?? error)}`);
          }
        }
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
    settings: settingsView(cfg),
    learnMcp: readLearnMcp(project.root),
    learn: { active: learn.mcp.active === true, error: learn.mcp.error, cli: learn.cli },
    project: {
      root: project.root,
      cwd: project.cwd,
      name: basename(project.root),
      scopeName: description.name,
      scope,
      scoped: scope !== project.root,
      skillsDir: skillsDir(project.root),
      catalogDir: catalogDir(project.root),
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

/**
 * Refuse a request a browser sent from another site, for reads as well as writes.
 *
 * The routes are served by the web carrier directly, so DSH's own peer checks do
 * not apply: without this, any page open in the same browser could read the
 * project facts (paths, packages) or toggle the Learn server. Browsers label the
 * caller in `Sec-Fetch-Site`; a caller that sends neither that header nor an
 * Origin (curl, a tool, the desktop shell) is let through.
 */
function crossSiteRefused(request) {
  const site = String(request.headers["sec-fetch-site"] ?? "").toLowerCase();
  if (site === "cross-site" || site === "same-site") return true;
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin === "string" && typeof host === "string") {
    try {
      if (new URL(origin).host !== host) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * checkout refresh timer (restartable, so a settings change applies at once)
 * ------------------------------------------------------------------ */

function createScheduler(cfg, updater) {
  let handles = [];
  const stop = () => {
    for (const handle of handles) clearTimeout(handle);
    handles = [];
  };
  const start = () => {
    stop();
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
  };
  return { start, stop };
}

function registerRoutes(ctx, updater, cfg, warn, scheduler) {
  try {
    ctx.inject(["webServer"], (scoped) => {
      try {
        if (typeof scoped?.webServer?.register !== "function") return;
        const disposers = [];
        const add = (route) => {
          // One colliding path must not cost the routes that follow it.
          try {
            disposers.push(scoped.webServer.register(route));
          } catch (error) {
            routeErrors.push(`${route.path}: ${String(error?.message ?? error)}`);
            warn(`could not register ${route.path}: ${String(error?.message ?? error)}`);
          }
        };
        add({
          kind: "exact",
          path: STATE_ROUTE,
          handler: async (request, response) => {
            if (crossSiteRefused(request)) {
              sendJson(response, 403, { ok: false, error: "this route answers only the DSH window" });
              return;
            }
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
            // Opening the panel registers this project's Learn choice, which is
            // what decides whether the process-wide MCP server stays mounted.
            if (panel.ok === true && panel.project && panel.project.root) {
              rememberProject(panel.project.root);
              void registerLearnProject(ctx, warn, panel.project.root).catch((error) => {
                warn(`could not track the project's Learn choice: ${String(error?.message ?? error)}`);
              });
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
        add({
          kind: "exact",
          path: APPLY_ROUTE,
          handler: async (request, response) => {
            if (crossSiteRefused(request) || !mutationAllowed(request)) {
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
              rememberProject(project.root);
              const result = injectProject(project.root, names, index);
              sendJson(response, 200, { ok: true, project: { root: project.root }, ...result, panel: await buildPanel(ctx, updater, cfg, body.sessionId, { lang: body.lang === "zh" ? "zh" : "en" }) });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        add({
          kind: "exact",
          path: CLEAR_ROUTE,
          handler: async (request, response) => {
            if (crossSiteRefused(request) || !mutationAllowed(request)) {
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
        add({
          kind: "exact",
          path: COUNT_ROUTE,
          handler: async (request, response) => {
            if (crossSiteRefused(request)) {
              sendJson(response, 403, { ok: false, error: "this route answers only the DSH window" });
              return;
            }
            const url = new URL(request.url ?? COUNT_ROUTE, "http://localhost");
            const project = resolveProject(ctx, url.searchParams.get("sessionId"));
            if (project.error !== undefined) {
              sendJson(response, 200, { ok: false, error: project.error });
              return;
            }
            // Cheap on purpose: no fact scan and no model call, just the manifest,
            // so the composer badge can follow another session's change cheaply.
            const names = Object.keys(readInjection(project.root).skills);
            sendJson(response, 200, { ok: true, root: project.root, injected: names.length, names });
          },
        });
        add({
          kind: "exact",
          path: SETTINGS_ROUTE,
          handler: async (request, response) => {
            if (crossSiteRefused(request)) {
              sendJson(response, 403, { ok: false, error: "this route answers only the DSH window" });
              return;
            }
            if ((request.method ?? "GET") === "GET") {
              sendJson(response, 200, { ok: true, settings: settingsView(cfg) });
              return;
            }
            if (crossSiteRefused(request) || !mutationAllowed(request)) {
              sendJson(response, 403, { ok: false, error: "this change has to come from the DSH window" });
              return;
            }
            const body = await readJsonBody(request);
            const patch = {};
            const interval = Number(body?.intervalHours);
            if (INTERVAL_OPTIONS.includes(interval)) patch.intervalHours = interval;
            const max = Math.round(Number(body?.selectMaxSkills));
            if (Number.isFinite(max)) patch.selectMaxSkills = Math.min(MAX_SKILLS_LIMIT, Math.max(MIN_SKILLS_LIMIT, max));
            if (Object.keys(patch).length === 0) {
              sendJson(response, 400, { ok: false, error: "nothing to save" });
              return;
            }
            try {
              await saveConfig(ctx, patch);
              Object.assign(cfg, patch);
              sendJson(response, 200, { ok: true, settings: settingsView(cfg) });
            } catch (error) {
              sendJson(response, 409, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        add({
          kind: "exact",
          path: LEARN_ROUTE,
          handler: async (request, response) => {
            if (!mutationAllowed(request) || (request.method ?? "GET") === "GET") {
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
              const enabled = setLearnMcp(project.root, body?.enabled === true);
              await registerLearnProject(ctx, warn, project.root);
              sendJson(response, 200, {
                ok: true,
                learnMcp: enabled,
                learn: { active: learn.mcp.active === true, error: learn.mcp.error, cli: learn.cli },
              });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        return () => {
          for (const dispose of disposers) {
            try {
              dispose();
            } catch {
              /* a route already gone must not break teardown */
            }
          }
        };
      } catch (error) {
        routeErrors.push(String(error));
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
                      settings: settingsView(cfg),
                      routeErrors,
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

  afterCatalogSync = () => syncKnownProjects(updater, warn);
  const scheduler = createScheduler(cfg, updater);
  registerRoutes(ctx, updater, cfg, warn, scheduler);
  // The Learn server follows the project toggles: a panel open registers its
  // project here, and the server mounts only while some project wants it.
  for (const root of knownLearnProjects()) learnProjects.add(root);
  try {
    void reconcileLearnMcp(ctx, warn);
  } catch (error) {
    warn(`could not reconcile the Microsoft Learn MCP server: ${String(error)}`);
  }
  registerTool(ctx, updater, cfg, warn);
  registerPromptSection(ctx, warn);

  try {
    ctx.effect(() => {
      scheduler.start();
      return () => scheduler.stop();
    });
  } catch (error) {
    warn(`could not schedule the timer: ${String(error)}`);
  }
}