// Host-side smoke test: project facts, model-output parsing, and injection
// provenance. Run with `node test/smoke.mjs` from the plugin directory.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeProject, looksLikeDotnet } from "../lib/project.js";
import { parseSelection } from "../lib/select.js";
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

  const description = describeProject(root);
  if (!looksLikeDotnet(description)) throw new Error("a .NET project was not recognised");
  if (!description.facts.frameworks.includes("net8.0-windows")) throw new Error("target framework was not read");
  if (!description.facts.packages.includes("Microsoft.EntityFrameworkCore")) throw new Error("package references were not read");
  if (description.facts.projects !== 1) throw new Error("project count was not read");

  // The model's answer survives fences, prose and unknown names.
  const catalog = [{ name: "msbuild" }, { name: "binlog-generation" }, { name: "xunit" }, { name: "coverlet" }];
  const parsed = parseSelection(
    'Sure!\n```json\n{"skills":[{"name":"msbuild","why":"build"},{"name":"xunit","why":"tests"},{"name":"unknown","why":"x"}]}\n```',
    catalog,
  );
  if (parsed.suggested.join(",") !== "msbuild,xunit") throw new Error(`parse failed: ${parsed.suggested.join(",")}`);
  if (parsed.reasons.msbuild !== "build") throw new Error("reason was not kept");
  const arrayForm = parseSelection('[{"name":"coverlet"}]', catalog);
  if (arrayForm.suggested[0] !== "coverlet") throw new Error("bare array form failed");

  // Injection provenance: the model may only remove what it added.
  const fixture = (name) => {
    const dir = join(root, `source-${name}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n# body\n`);
    return { name, description: "fixture", tokens: 10, collection: "Fixture", packageName: "Fixture", segments: ["Fixture"], dir };
  };
  const userSkill = fixture("fixture-user");
  const modelSkill = fixture("fixture-model");
  const index = { skills: [userSkill, modelSkill] };

  injectProject(root, [userSkill.name], index, { source: "user" });
  if (readInjection(root).skills[userSkill.name]?.source !== "user") throw new Error("user provenance was not recorded");

  const modelAdded = applyProject(root, [modelSkill.name], [], index);
  if (modelAdded.added[0] !== modelSkill.name) throw new Error("model add did not append");

  const blocked = applyProject(root, [], [userSkill.name], index);
  if (blocked.removed.length !== 0 || blocked.protected[0] !== userSkill.name) throw new Error("user-owned skill was not protected");

  const dropped = applyProject(root, [], [modelSkill.name], index);
  if (dropped.removed[0] !== modelSkill.name) throw new Error("model-owned skill was not removed");

  if (!existsSync(join(skillsDir(root), userSkill.name, "SKILL.md"))) throw new Error("protected skill disappeared");
  clearProject(root);
  if (Object.keys(readInjection(root).skills).length !== 0) throw new Error("clear did not empty the manifest");

  console.log("smoke ok:", description.labels.join(", "), "· parsing + provenance enforced");
} finally {
  rmSync(root, { recursive: true, force: true });
}
