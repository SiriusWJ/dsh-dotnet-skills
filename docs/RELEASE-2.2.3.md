## v2.2.3 — 拒绝对跨站调用，收录说明中的安全提示可以撤掉

### 谁写的「HTTP 路由没有访问检查」那句话
不是本插件，也不是 dsh-market 生成的。它是 **awesome-dsh-plugin 列表的维护者（fkysly）在合并评审时改写的**：

```
commit c545db183  "Disclose routes, fix names, pin renamed dates, drop fixed caveat (11-18 round 1)"
author fkysly <fkysly@gmail.com>  2026-11-18
file   data/plugins/SiriusWJ__dsh-dotnet-skills.yml
```

他们在 `description.en` / `description.zh` 后面追加了
“Its HTTP routes have no DSH access check, so a web page open in your browser could call them.”（中文版被追加了**两遍**，是他们的编辑疏漏）。dsh-market 只是原样渲染列表里的描述，所以卡片上看到的就是这段。

### 这次做了什么
这句话指出的问题是真的：路由直接挂在 web 载体上，不受 DSH 的 peer 授权约束。现在为**所有路由**加了跨站拒绝：

- 读取路由（`/state`、`/settings`）此前只有写操作做同源检查，现在同样检查；
- 依据 `Sec-Fetch-Site`（`cross-site` / `same-site` 直接 403）与 `Origin` 与 `Host` 比对；
- 不带这两个头的调用方（curl、工具、桌面壳）照常放行。

实测：

```
同源/无头          GET /state            → 200
Sec-Fetch-Site: cross-site  GET /state   → 403
Sec-Fetch-Site: cross-site  GET /settings → 403
```

### 版本
`2.2.3`；`smoke` / `layout` / `css-audit` 三项测试通过。列表侧的说明已另行提 PR 请求移除（并修掉重复的那一句）。
