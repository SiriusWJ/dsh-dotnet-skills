// Standalone harness: runs the plugin's real apply() with a stub ctx, so the
// git + mirror path can be exercised without restarting DSH.
const tools = [];
const ctx = {
  logger: { warn: (m) => console.log("warn:", m) },
  inject: (_names, cb) =>
    cb({
      tools: { register: (def) => (tools.push(def), () => {}) },
      on: () => {},
    }),
  effect: (fn) => {
    const dispose = fn();
    return dispose;
  },
};

const mod = await import("file:///D:/code/dsh/dsh-dotnet-skills/index.js");
mod.apply(ctx, { runOnStart: false, intervalHours: 6 });

const tool = tools[0];
if (!tool) {
  console.log("no tool registered");
  process.exit(1);
}
for (const round of [1, 2]) {
  const result = await tool.execute({ action: "sync" }, {});
  console.log(`--- round ${round} ---`);
  console.log(result.report.split("\n").slice(4, 9).join("\n"));
}
process.exit(0);
