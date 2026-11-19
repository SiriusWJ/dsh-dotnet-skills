## v2.2.4 — 同一工作目录下的会话自动同步选择

### 问题
在同一个项目里开了多个会话时，A 会话注入/清空技能，B 会话 composer 上的 `dotnet技能` 徽标**不会变**——要等你在 B 里点开面板（那一次会请求 `/state`）才更新。

### 原因
徽标只在挂载时、以及 `store.open` 变化时请求一次 `/state`。而 `/state` 会**扫描项目事实、必要时调用模型**（约 7 秒），显然不能拿它做轮询。

### 改法
新增一个极轻量的路由，并把徽标改成「按需 + 低频轮询」：

```
GET /dsh-dotnet-skills/count?sessionId=…
→ { "ok": true, "root": "D:\\code\\dsh", "injected": 1, "names": ["xunit"] }
```

- **只读一次 manifest**：不扫项目、不调模型，响应是毫秒级；
- 徽标在挂载时、`focus`、标签页重新可见时、以及**每 10 秒**（仅页面可见时）刷新一次；
- 面板仍然只在打开时请求 `/state`，打开面板才花钱这一点没有改变；
- 该路由同样受跨站拒绝保护（`Sec-Fetch-Site: cross-site` → 403）。

### 实测
在 B 会话之外通过工具注入一个技能，不打开面板直接查：

```
GET /count → {"injected":1,"names":["xunit"]}
移除后     → {"injected":0,"names":[]}
GET /count (Sec-Fetch-Site: cross-site) → 403
```

### 版本
`2.2.4`；`node test/smoke.mjs`、`node test/layout.mjs`、`node test/css-audit.mjs` 通过。
