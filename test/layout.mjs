// Layout check: one skill, two copies, and a catalog update that reaches both.
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogDir, clearProject, injectProject, skillsDir, syncProjectSkills } from "../lib/inject.js";

const root = mkdtempSync(join(tmpdir(), "dsh-dotnet-skills-layout-"));
try {
  const dir = join(root, "source", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: fixture\n---\nv1\n");
  const skill = { name: "demo", description: "fixture", tokens: 5, collection: "F", packageName: "F", segments: ["F"], dir };

  injectProject(root, ["demo"], { skills: [skill] }, { source: "user" });
  const repository = join(catalogDir(root), "demo", "SKILL.md");
  const flat = join(skillsDir(root), "demo", "SKILL.md");
  if (!existsSync(repository)) throw new Error(`the managed copy is missing: ${repository}`);
  if (!existsSync(flat)) throw new Error(`the discovered copy is missing: ${flat}`);
  console.log("repository:", repository);
  console.log("discovered:", flat);

  writeFileSync(join(dir, "SKILL.md"), "---\nname: demo\ndescription: fixture\n---\nv2\n");
  const result = syncProjectSkills(root, { skills: [skill] });
  if (result.updated !== 1) throw new Error(`sync did not update: ${JSON.stringify(result)}`);
  if (!readFileSync(repository, "utf8").includes("v2")) throw new Error("the managed copy was not refreshed");
  if (!readFileSync(flat, "utf8").includes("v2")) throw new Error("the discovered copy was not refreshed");

  clearProject(root);
  if (existsSync(join(catalogDir(root), "demo"))) throw new Error("the managed copy survived clear");
  if (existsSync(join(skillsDir(root), "demo"))) throw new Error("the discovered copy survived clear");
  console.log("layout ok: two copies, synced and cleared together");
} finally {
  rmSync(root, { recursive: true, force: true });
}
