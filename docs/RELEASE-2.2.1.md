## v2.2.1 — 修复 Learn 开关样式失效

### 问题
面板右上角的 Microsoft Learn 胶囊里，开关变成了一个灰色小方块、白色滑块消失，「已关闭」文字还会被挤到一起。

### 根因
样式表里残留了两段**没有选择器的孤儿声明片段**（清理旧规则时留下的续行），它们结尾带有多余的 `}`：

```css
.dsdk-cfg-save:disabled{opacity:.45;cursor:default}
background:transparent;color:inherit;...cursor:pointer}   ← 孤儿，多余的 }
.dsdk-switch{ ... }                                        ← 被提前闭合，整条失效
```

CSS 解析器遇到多余的 `}` 会提前结束当前块，紧跟其后的规则被整条丢弃：

- `.dsdk-switch` 样式丢失 → 浏览器默认按钮外观；
- `.dsdk-switch span` 的 `position:absolute` 丢失 → 白色滑块宽度变 0，不可见。

### 修复
- 删除两处孤儿片段，并把拆成两段的 `.dsdk-learn-pill` 规则合并；
- 校验拼装后的 CSS：大括号 **88 / 88**，平衡；
- 标题栏布局加固（上一版已包含）：标题行、右侧组、胶囊均不收缩，状态文字省略号显示，窗口小于 760px 时隐藏状态文字与分析 chip。

### 新增守卫测试
`test/css-audit.mjs`——三件事一次校验，防止再次回归：

1. 检出任何「无选择器的声明片段」；
2. 断言拼装后的 CSS 大括号平衡；
3. 确认 `.dsdk-switch span`、`.dsdk-learn-pill{`、`@media (max-width:760px)` 等关键规则存在。

```bash
node test/css-audit.mjs client/client.js
# css ok: no orphan fragments, balanced, switch and pill rules present
```

### 验证
- `node test/smoke.mjs` — 事实采集、模型输出解析、归属保护
- `node test/layout.mjs` — 双份副本、目录同步、清空
- `node test/css-audit.mjs` — 样式表完整性
- 插件重载后 `/dsh-dotnet-skills/settings` 返回 200

### 安装
```bash
dsh plugin add https://github.com/SiriusWJ/dsh-dotnet-skills
```
已安装的用户更新后需要刷新一次页面（Ctrl+R）以加载新的客户端样式。
