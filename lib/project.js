/**
 * What the project looks like — facts only, no skill guessing.
 *
 * The old version mapped these facts to catalog packages with a rule table,
 * which over-suggested on any project with a few common packages. Now the facts
 * are the *input* to a model call (lib/select.js); this module just gathers them.
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
]);

const MAX_FILES = 4000;
const MAX_DEPTH = 8;
const MAX_TEXT = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".csproj", ".props", ".targets", ".json", ".config", ".sln", ".slnx", ".cs", ".xaml", ".razor", ".fsproj", ".vbproj"]);

function walk(root) {
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
      if (entry.name.startsWith(".")) continue;
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
 * Describe one project root.
 * @returns `{ root, name, facts: { frameworks, packages, projects, extensions }, labels }`
 */
export function describeProject(root) {
  const files = walk(root);
  const packages = new Set();
  const frameworks = new Set();
  const extensions = new Map();
  const projectNames = [];
  let projectCount = 0;

  for (const path of files) {
    const name = basename(path);
    const extension = extname(path).toLowerCase();
    extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
    if (extension === ".csproj" || extension === ".fsproj" || extension === ".vbproj") {
      projectCount += 1;
      if (projectNames.length < 12) projectNames.push(name.replace(/\.(cs|fs|vb)proj$/u, ""));
    }
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const text = readText(path);
    if (text === "") continue;
    const packagePattern = /<PackageReference[^>]*Include\s*=\s*"([^"]+)"/giu;
    let match = packagePattern.exec(text);
    while (match !== null) {
      packages.add(match[1]);
      match = packagePattern.exec(text);
    }
    const versionPattern = /<PackageVersion[^>]*Include\s*=\s*"([^"]+)"/giu;
    match = versionPattern.exec(text);
    while (match !== null) {
      packages.add(match[1]);
      match = versionPattern.exec(text);
    }
    const frameworkPattern = /<TargetFrameworks?>([^<]+)</giu;
    match = frameworkPattern.exec(text);
    while (match !== null) {
      for (const entry of match[1].split(";")) {
        const value = entry.trim().toLowerCase();
        if (value !== "") frameworks.add(value);
      }
      match = frameworkPattern.exec(text);
    }
    const sdkPattern = /<Project[^>]*Sdk\s*=\s*"([^"]+)"/iu.exec(text);
    if (sdkPattern !== null && /\.web$/iu.test(sdkPattern[1])) packages.add("Microsoft.NET.Sdk.Web");
  }

  const importantPackages = [...packages].sort((left, right) => left.localeCompare(right)).slice(0, 40);
  const frameworksList = [...frameworks].sort();
  const labels = [];
  for (const framework of frameworksList.slice(0, 4)) labels.push(framework);
  for (const marker of ["Microsoft.NET.Sdk.Web", "Microsoft.EntityFrameworkCore", "xunit", "nunit", "MSTest.TestFramework", "System.Windows.Forms", "PresentationFramework", "Microsoft.Maui.Controls", "Avalonia", "Microsoft.Orleans", "Aspire.Hosting", "Microsoft.SemanticKernel", "Microsoft.Agents", "ModelContextProtocol"]) {
    if (packages.has(marker)) labels.push(marker.replace(/^Microsoft\./u, "").replace(/\.Controls$/u, ""));
  }
  if (projectCount > 0) labels.push(`${projectCount} project${projectCount === 1 ? "" : "s"}`);

  return {
    root,
    name: basename(root),
    facts: {
      projects: projectCount,
      projectNames,
      frameworks: frameworksList,
      packages: importantPackages,
      extensions: [...extensions.entries()].sort((left, right) => right[1] - left[1]).slice(0, 10),
      files: files.length,
    },
    labels: [...new Set(labels)].slice(0, 10),
  };
}

/** A stable key for caching one analysis (facts change ⇒ new analysis). */
export function factsFingerprint(description) {
  const facts = description.facts;
  return `${description.root}|${facts.projects}|${facts.frameworks.join(",")}|${facts.packages.join(",")}|${facts.files}`;
}

/** Whether the project shows any .NET trace at all. */
export function looksLikeDotnet(description) {
  return description.facts.projects > 0 || description.facts.frameworks.length > 0 || existsSync(join(description.root, "global.json"));
}
