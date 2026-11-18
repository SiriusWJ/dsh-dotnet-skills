## v2.2.2 — 声明宿主要求，说明目录是官方 .NET 技能的超集

### 宿主要求（`engines.dsh`）
插件此前没有声明自己需要哪个版本的 DeepSeek Harness，装到不兼容的宿主上会「半残可用」。

`package.json` 现在声明：

```json
"engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
```

- 低于 `0.2.2-rc.1` 或高于 `0.3.0` 的宿主会**直接拒绝安装/激活**，而不是装上后静默出错；
- 当前运行的 `0.2.2-rc.3` 满足该范围，实测重载后 `/dsh-dotnet-skills/settings` 返回 200。

### 目录来源：官方 .NET 技能的超集
README（中英）新增「技能目录」章节，并用 `dotnet/skills@main` 实际核对过：

| 指标 | 数量 |
|---|---|
| 本插件的目录（managedcode/dotnet-skills） | **203** 个技能，5 个集合 |
| 官方 `dotnet/skills` 发布的技能 | **108** 个 |
| 官方技能在目录中缺失的数量 | **0**（同名全部存在，无删减、无改名） |
| 目录比官方多出的社区技能 | **95** 个 |

也就是说它是官方集合的**严格超集**，两个源可以互换而不损失覆盖；想直接跟踪 `dotnet/skills` 时改 `repoUrl` 即可。

README 同时新增「环境要求」表：DSH 版本、Node.js、DSH 进程 PATH 中的 `git`、以及只在开启 Learn MCP 时才访问 `learn.microsoft.com`。

### 其它
- `locale/zh.json`、`locale/en.json` 的插件简介同步补上「官方 dotnet/skills 的超集（含全部 108 个）」与版本要求；
- 版本 `2.2.2`；`smoke` / `layout` / `css-audit` 三项测试通过。
