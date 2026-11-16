// Host-side smoke test: detection + injection against a throwaway project.
// Run with `node test/smoke.mjs` from the plugin directory.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
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

  const fixture = (name) => {
    const dir = join(root, `source-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n# body\n`);
    return { name, description: "fixture", tokens: 10, collection: "Fixture", packageName: "Fixture", segments: ["Fixture"], dir };
  };
  const userSkill = fixture("fixture-user");
  const modelSkill = fixture("fixture-model");
  const index = { skills: [userSkill, modelSkill] };

  // The panel path: user-owned.
  const applied = injectProject(root, [userSkill.name], index, { source: "user" });
  if (applied.injected.length !== 1) throw new Error("inject did not report the skill");
  if (!existsSync(join(skillsDir(root), userSkill.name, "SKILL.md"))) throw new Error("skill was not copied");
  if (readInjection(root).skills[userSkill.name]?.source !== "user") throw new Error("user provenance was not recorded");

  const again = injectProject(root, [userSkill.name], index, { source: "user" });
  if (again.copied !== 0 || again.unchanged !== 1) throw new Error("re-injection was not incremental");

  // The model path: adds, and may only remove what it added itself.
  const modelAdded = applyProject(root, [modelSkill.name], [], index);
  if (modelAdded.added[0] !== modelSkill.name) throw new Error("model add did not append");
  if (readInjection(root).skills[modelSkill.name]?.source !== "model") throw new Error("model provenance was not recorded");

  const blocked = applyProject(root, [], [userSkill.name], index);
  if (blocked.removed.length !== 0 || blocked.protected[0] !== userSkill.name) throw new Error("user-owned skill was not protected");
  if (!existsSync(join(skillsDir(root), userSkill.name, "SKILL.md"))) throw new Error("protected skill disappeared");

  const dropped = applyProject(root, [], [modelSkill.name], index);
  if (dropped.removed[0] !== modelSkill.name) throw new Error("model-owned skill was not removed");
  if (existsSync(join(skillsDir(root), modelSkill.name))) throw new Error("removed skill stayed on disk");

  clearProject(root);
  if (existsSync(join(skillsDir(root), userSkill.name))) throw new Error("clear left the skill behind");
  if (Object.keys(readInjection(root).skills).length !== 0) throw new Error("clear did not empty the manifest");

  console.log("smoke ok:", labels.join(", "), "· provenance enforced");
} finally {
  rmSync(root, { recursive: true, force: true });
}
