// Host-side smoke test: detection + injection against a throwaway project.
// Run with `node test/smoke.mjs` from the plugin directory.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeProject } from "../lib/detect.js";
import { applyProject, injectProject, clearProject, readInjection, skillsDir } from "../lib/inject.js";

const root = mkdtempSync(join(tmpdir(), "dsh-dotnet-skills-"));
try {
  mkdirSync(join(root, "App"), { recursive: true });
  writeFileSync(
    join(root, "App", "App.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
    <PackageReference Include="xunit" Version="2.9.0" />
  </ItemGroup>
</Project>`,
  );
  writeFileSync(join(root, "App", "Form1.Designer.cs"), "namespace App; partial class Form1 { }");

  const analysis = analyzeProject(root);
  const labels = analysis.signals.map((signal) => signal.label);
  for (const expected of [".NET project", "MSBuild", "Windows Forms", "Entity Framework Core", "xUnit"]) {
    if (!labels.includes(expected)) throw new Error(`detection missed ${expected}: ${labels.join(", ")}`);
  }

  const skillDir = join(root, "..", "fixture-skill");
  const index = {
    skills: [
      {
        name: "fixture-skill",
        description: "fixture",
        tokens: 10,
        collection: "Fixture",
        packageName: "Fixture",
        segments: ["Fixture"],
        dir: join(root, "fixture-source"),
      },
    ],
  };
  mkdirSync(index.skills[0].dir, { recursive: true });
  writeFileSync(join(index.skills[0].dir, "SKILL.md"), "---\nname: fixture-skill\ndescription: fixture\n---\n# body\n");

  const applied = injectProject(root, ["fixture-skill"], index);
  if (applied.injected.length !== 1) throw new Error("inject did not report the skill");
  if (!existsSync(join(skillsDir(root), "fixture-skill", "SKILL.md"))) throw new Error("skill was not copied");
  if (!readInjection(root).skills["fixture-skill"]) throw new Error("manifest was not written");

  const again = injectProject(root, ["fixture-skill"], index);
  if (again.copied !== 0 || again.unchanged !== 1) throw new Error("re-injection was not incremental");

  // Model-facing apply appends and never drops what was already there.
  const kept = applyProject(root, [], [], index);
  if (kept.injected.length !== 1 || kept.added.length !== 0) throw new Error("apply without names disturbed the set");
  const dropped = applyProject(root, [], ["fixture-skill"], index);
  if (dropped.injected.length !== 0 || dropped.removed[0] !== "fixture-skill") throw new Error("apply remove did not drop the skill");
  const restored = applyProject(root, ["fixture-skill"], [], index);
  if (restored.injected.length !== 1 || restored.added[0] !== "fixture-skill") throw new Error("apply did not append");

  clearProject(root);
  if (existsSync(join(skillsDir(root), "fixture-skill"))) throw new Error("clear left the skill behind");
  if (Object.keys(readInjection(root).skills).length !== 0) throw new Error("clear did not empty the manifest");

  console.log("smoke ok:", labels.join(", "));
} finally {
  rmSync(root, { recursive: true, force: true });
}
