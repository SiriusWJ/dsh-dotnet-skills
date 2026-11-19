## v2.2.5 — 切换会话后徽标立刻跟上

### 现象
在同一工作区里第一次切换会话，`dotnet技能` 徽标不刷新；再切一次才更新——数字总是慢一步。

### 原因
切换会话的那一瞬间，新会话在宿主里**还没登记完**。徽标此时发出的 `/count` 读到的是：

```json
{ "ok": false, "error": "no live session for that id" }
```

之前把这种失败当成「这次算了」，于是保留旧数字；等下一次切换（或 10 秒轮询）才拿到正确值，看起来就是慢一拍。

### 改法
- 读失败不再静默丢弃，而是**退避重试**：0.4s → 0.8s → 1.2s → 1.6s（最多 4 次），所以新会话登记好之后 1 秒内就能拿到正确数量；
- 仍保留 10 秒轮询，以及 `focus` / 标签页重新可见时的即时刷新；
- 用序号（`sequence`）丢弃过期响应，快速连切会话时不会出现旧请求覆盖新结果；
- 重试只在页面可见时进行，后台标签不打扰。

### 验证
```
GET /count?sessionId=<不存在的 id>  → {"ok":false,"error":"no live session for that id"}   ← 触发重试
GET /count?sessionId=<真实会话>     → {"ok":true,"root":"D:\\code\\dsh","injected":1,"names":["agentic-workflows"]}
```

### 版本
`2.2.5`；`smoke` / `layout` / `css-audit` 三项测试通过。