/**
 * Stack detection — pure local rules over project files, no model, no network.
 *
 * The composer panel runs this every time it opens: scan the project root,
 * recognise the .NET stack in use, and translate the recognised stacks into
 * catalog packages. Every rule reports the evidence that fired it, so the panel
 * can explain *why* a skill was suggested.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  ".dsh",
  "node_modules",
  "bin",
  "obj",
  "packages",
  ".vs",
  ".idea",
  ".vscode",
  "artifacts",
  "TestResults",
  "wwwroot/lib",
]);

const MAX_FILES = 4000;
const MAX_DEPTH = 8;
const MAX_TEXT = 512 * 1024;

/** Files whose content drives detection. */
const TEXT_EXTENSIONS = new Set([".csproj", ".props", ".targets", ".json", ".config", ".sln", ".slnx", ".cs", ".xaml", ".razor", ".fsproj", ".vbproj"]);

function walk(root, budget) {
  const files = [];
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && files.length < MAX_FILES) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const path = join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || current.depth + 1 > MAX_DEPTH) continue;
        queue.push({ dir: path, depth: current.depth + 1 });
        continue;
      }
      files.push(path);
    }
  }
  return files;
}

function readText(path) {
  try {
    if (statSync(path).size > MAX_TEXT) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Rule table: `id` is the signal, `label` its human name, `packages` the catalog
 * packages that should be suggested, `match` the predicate over the scan facts.
 */
const RULES = [
  {
    id: "dotnet",
    label: ".NET project",
    match: (f) => f.projectCount > 0 || f.ext(".sln") > 0 || f.files.has("global.json"),
    packages: ["DotNet", "Official-DotNet", "Modern-CSharp", "Code-Review"],
  },
  {
    id: "build",
    label: "MSBuild",
    match: (f) => f.projectCount > 0 || f.ext(".sln") > 0,
    packages: ["Official-DotNet-MSBuild"],
  },
  {
    id: "winforms",
    label: "Windows Forms",
    match: (f) => f.has("usewindowsforms") || f.packages.has("system.windows.forms") || f.designerFiles > 0,
    packages: ["WinForms", "Official-DotNet-WinForms"],
  },
  {
    id: "wpf",
    label: "WPF",
    match: (f) => f.has("usewpf") || f.packages.has("presentationframework") || f.ext(".xaml") > 0,
    packages: ["WPF", "MVVM-Toolkit"],
  },
  {
    id: "winui",
    label: "WinUI 3",
    match: (f) => f.packages.has("microsoft.windowsappsdk") || f.has("usewinui"),
    packages: ["WinUI"],
  },
  {
    id: "avalonia",
    label: "Avalonia",
    match: (f) => [...f.packages].some((p) => p.startsWith("avalonia")),
    packages: ["Avalonia"],
  },
  {
    id: "uno",
    label: "Uno Platform",
    match: (f) => [...f.packages].some((p) => p.startsWith("uno.")),
    packages: ["Uno-Platform"],
  },
  {
    id: "maui",
    label: ".NET MAUI",
    match: (f) => f.has("usemaui") || f.files.has("mauiprogram.cs"),
    packages: ["MAUI", "Official-DotNet-MAUI"],
  },
  {
    id: "aspnetcore",
    label: "ASP.NET Core",
    match: (f) => f.has("microsoft.net.sdk.web") || [...f.packages].some((p) => p.startsWith("microsoft.aspnetcore")),
    packages: ["ASP.NET-Core", "Web-API", "Minimal-APIs", "Official-DotNet-ASPNetCore"],
  },
  {
    id: "blazor",
    label: "Blazor",
    match: (f) => f.ext(".razor") > 0,
    packages: ["Blazor", "Official-DotNet-Blazor"],
  },
  {
    id: "grpc",
    label: "gRPC",
    match: (f) => [...f.packages].some((p) => p.startsWith("grpc.")) || f.ext(".proto") > 0,
    packages: ["gRPC"],
  },
  {
    id: "signalr",
    label: "SignalR",
    match: (f) => [...f.packages].some((p) => p.includes("signalr")),
    packages: ["SignalR"],
  },
  {
    id: "efcore",
    label: "Entity Framework Core",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.entityframeworkcore")),
    packages: ["Entity-Framework-Core", "Official-DotNet-Data"],
  },
  {
    id: "ef6",
    label: "Entity Framework 6",
    match: (f) => f.packages.has("entityframework") || f.text.includes("system.data.entity"),
    packages: ["Entity-Framework-6", "Official-DotNet-Data"],
  },
  {
    id: "tests",
    label: "Tests",
    match: (f) => [...f.packages].some((p) => ["xunit", "xunit.v3", "nunit", "mstest.testframework", "microsoft.net.test.sdk", "tunit"].includes(p)),
    packages: [],
  },
  {
    id: "xunit",
    label: "xUnit",
    match: (f) => [...f.packages].some((p) => p === "xunit" || p === "xunit.v3"),
    packages: ["xUnit"],
  },
  {
    id: "nunit",
    label: "NUnit",
    match: (f) => f.packages.has("nunit"),
    packages: ["NUnit"],
  },
  {
    id: "mstest",
    label: "MSTest",
    match: (f) => f.packages.has("mstest.testframework") || f.packages.has("mstest.sdk"),
    packages: ["MSTest"],
  },
  {
    id: "coverage",
    label: "Coverage",
    match: (f) => f.packages.has("coverlet.collector") || f.packages.has("coverlet.msbuild"),
    packages: ["Coverlet"],
  },
  {
    id: "stryker",
    label: "Mutation testing",
    match: (f) => [...f.packages].some((p) => p.startsWith("stryker")),
    packages: ["Stryker"],
  },
  {
    id: "playwright",
    label: "Playwright",
    match: (f) => [...f.packages].some((p) => p.includes("playwright")),
    packages: ["Playwright"],
  },
  {
    id: "orleans",
    label: "Orleans",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.orleans")),
    packages: ["Orleans"],
  },
  {
    id: "aspire",
    label: "Aspire",
    match: (f) => [...f.packages].some((p) => p.startsWith("aspire.")),
    packages: ["Aspire"],
  },
  {
    id: "functions",
    label: "Azure Functions",
    match: (f) => f.files.has("host.json") || [...f.packages].some((p) => p.startsWith("microsoft.azure.functions.worker")),
    packages: ["Azure-Functions"],
  },
  {
    id: "wcf",
    label: "WCF",
    match: (f) => [...f.packages].some((p) => p.startsWith("system.servicemodel")),
    packages: ["WCF"],
  },
  {
    id: "workflow",
    label: "Workflow Foundation",
    match: (f) => [...f.packages].some((p) => p.startsWith("system.activities")),
    packages: ["Workflow-Foundation"],
  },
  {
    id: "semantic-kernel",
    label: "Semantic Kernel",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.semantickernel")),
    packages: ["Semantic-Kernel"],
  },
  {
    id: "agent-framework",
    label: "Agent Framework",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.agents")),
    packages: ["Microsoft-Agent-Framework"],
  },
  {
    id: "meai",
    label: "Microsoft.Extensions.AI",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.extensions.ai")),
    packages: ["Microsoft-Extensions-AI"],
  },
  {
    id: "mlnet",
    label: "ML.NET",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.ml")),
    packages: ["ML.NET"],
  },
  {
    id: "mcp",
    label: "MCP",
    match: (f) => [...f.packages].some((p) => p.includes("modelcontextprotocol")),
    packages: ["MCP"],
  },
  {
    id: "di",
    label: "Microsoft.Extensions",
    match: (f) => [...f.packages].some((p) => p.startsWith("microsoft.extensions.") && p !== "microsoft.extensions.ai"),
    packages: ["Microsoft-Extensions"],
  },
  {
    id: "cpm",
    label: "Central Package Management",
    match: (f) => f.files.has("directory.packages.props"),
    packages: ["Official-DotNet-NuGet", "NuGetPackageManager", "convert-to-cpm"],
  },
  {
    id: "analyzers",
    label: "Analyzers / formatting",
    match: (f) => f.packages.has("stylecop.analyzers") || f.packages.has("roslynator.analyzers") || f.packages.has("meziantou.analyzer") || f.files.has(".editorconfig"),
    packages: ["Analyzer-Config", "Format", "Complexity"],
  },
  {
    id: "csharpier",
    label: "CSharpier",
    match: (f) => [...f.packages, ...f.toolNames].some((p) => p.includes("csharpier")),
    packages: ["CSharpier"],
  },
  {
    id: "architecture",
    label: "Solution architecture",
    match: (f) => f.projectCount >= 3,
    packages: ["Architecture", "Project-Setup"],
  },
  {
    id: "binlog",
    label: "Build diagnostics",
    match: (f) => f.ext(".binlog") > 0 || f.packages.has("microsoft.aitools.binlogmcp"),
    packages: ["Official-DotNet-Diagnostics"],
  },
  {
    id: "benchmark",
    label: "BenchmarkDotNet",
    match: (f) => f.packages.has("benchmarkdotnet"),
    packages: ["Official-DotNet-Diagnostics"],
  },
  {
    id: "net11",
    label: ".NET 11",
    match: (f) => f.frameworks.some((tfm) => tfm.startsWith("net11.")),
    packages: ["Official-DotNet-Dotnet11"],
  },
  {
    id: "legacy",
    label: "Legacy .NET Framework",
    match: (f) => f.frameworks.some((tfm) => /^net4/u.test(tfm)) || f.files.has("packages.config"),
    packages: ["Official-DotNet-Upgrade"],
  },
  {
    id: "legacy-aspnet",
    label: "Legacy ASP.NET",
    match: (f) => f.ext(".aspx") > 0 || f.packages.has("system.web") || f.packages.has("microsoft.aspnet.webpages"),
    packages: ["Legacy-ASP.NET"],
  },
];

function scanFacts(root) {
  const files = walk(root, { count: 0 });
  const facts = {
    files: new Set(),
    packages: new Set(),
    toolNames: new Set(),
    frameworks: [],
    projectCount: 0,
    designerFiles: 0,
    extensions: new Map(),
    text: "",
    has(marker) {
      return this.text.toLowerCase().includes(marker);
    },
    ext(extension) {
      return this.extensions.get(extension) ?? 0;
    },
  };
  const textParts = [];
  for (const path of files) {
    const name = basename(path).toLowerCase();
    const extension = extname(path).toLowerCase();
    facts.files.add(name);
    facts.extensions.set(extension, (facts.extensions.get(extension) ?? 0) + 1);
    if (name.endsWith(".designer.cs")) facts.designerFiles += 1;
    if (extension === ".csproj" || extension === ".fsproj" || extension === ".vbproj") facts.projectCount += 1;
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const text = readText(path);
    if (text === "") continue;
    textParts.push(text.slice(0, 20000));
    const packagePattern = /<PackageReference[^>]*Include\s*=\s*"([^"]+)"/giu;
    let match = packagePattern.exec(text);
    while (match !== null) {
      facts.packages.add(match[1].toLowerCase());
      match = packagePattern.exec(text);
    }
    const sdkPattern = /<Project[^>]*Sdk\s*=\s*"([^"]+)"/iu.exec(text);
    if (sdkPattern !== null) textParts.push(sdkPattern[1].toLowerCase());
    const frameworkPattern = /<TargetFrameworks?>([^<]+)</giu;
    let tfm = frameworkPattern.exec(text);
    while (tfm !== null) {
      for (const entry of tfm[1].split(";")) {
        const value = entry.trim().toLowerCase();
        if (value !== "" && !facts.frameworks.includes(value)) facts.frameworks.push(value);
      }
      tfm = frameworkPattern.exec(text);
    }
    const toolPattern = /<PackageVersion[^>]*Include\s*=\s*"([^"]+)"/giu;
    match = toolPattern.exec(text);
    while (match !== null) {
      facts.packages.add(match[1].toLowerCase());
      match = toolPattern.exec(text);
    }
    if (name === "directory.packages.props" || name === "directory.build.props") facts.files.add(name);
  }
  facts.text = textParts.join("\n").toLowerCase();
  return facts;
}

/**
 * Analyse one project root.
 * @returns `{ root, name, signals: Array<{id,label,packages}>, packages: string[], stats }`
 */
export function analyzeProject(root) {
  const facts = scanFacts(root);
  const signals = [];
  const packages = new Set();
  for (const rule of RULES) {
    let matched = false;
    try {
      matched = rule.match(facts) === true;
    } catch {
      matched = false;
    }
    if (!matched) continue;
    signals.push({ id: rule.id, label: rule.label, packages: rule.packages });
    for (const name of rule.packages) packages.add(name);
  }
  return {
    root,
    name: basename(root),
    signals,
    packages: [...packages],
    stats: {
      projects: facts.projectCount,
      files: facts.files.size,
      frameworks: facts.frameworks.slice(0, 6),
      packageReferences: facts.packages.size,
    },
  };
}
