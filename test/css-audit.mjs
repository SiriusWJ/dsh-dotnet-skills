// Guard the injected stylesheet: every fragment must belong to a rule, and the
// joined CSS must be balanced. A stray declaration fragment (a leftover from a
// deleted rule) silently breaks the rules that follow it — that is how the
// composer switch once lost its knob.
import { readFileSync } from "node:fs";

const source = readFileSync(process.argv[2] ?? "client/client.js", "utf8");
const lines = source.split(/\r?\n/);
const problems = [];

for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index].trimEnd();
  if (!/^\s+'[a-z-]+:/.test(line)) continue;
  const previous = (lines[index - 1] ?? "").trimEnd();
  const continuesRule = /^\s+'(\.[a-zA-Z@#]|\/\*)/.test(previous) || /\{$/.test(previous) === false && /,\s*$/.test(previous);
  if (!continuesRule) problems.push(`line ${index + 1}: orphan declaration fragment → ${line.trim()}`);
}

const start = source.indexOf("const CSS = [");
const end = source.indexOf("].join(");
if (start === -1 || end === -1) {
  problems.push("the CSS array was not found");
} else {
  const literal = source.slice(start + "const CSS = ".length, end + 1);
  const BRAND = "#000";
  const css = eval(literal).join("");
  const open = (css.match(/\{/g) ?? []).length;
  const close = (css.match(/\}/g) ?? []).length;
  if (open !== close) problems.push(`the joined CSS is unbalanced: ${open} "{" vs ${close} "}"`);
  for (const selector of [".dsdk-switch span", ".dsdk-learn-pill{", "@media (max-width:760px)"]) {
    if (!css.includes(selector)) problems.push(`missing rule: ${selector}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("css ok: no orphan fragments, balanced, switch and pill rules present");
