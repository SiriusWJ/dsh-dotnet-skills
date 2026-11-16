## v2.2.0 — 中英双语界面，语言随 DSH 自动切换

### 界面语言
按钮、浮窗、设置卡片全部走两套字典，判定顺序为 `<html lang>` → `navigator.language` → 英文。

- 语言在 **运行中切换也立即生效**：监听 `languagechange` 事件与 `<html lang>` 的属性变化，
  不需要重启插件或刷新页面。
- 之前遗漏在代码里的英文文案（无会话标识、面板空数据、保存失败、切换 Learn 失败、
  缓存 chip、设置页 tooltip）全部收进字典。
- 两份字典现在键完全一致（各 49 项），同时删掉了两个没人使用的键。

### 文档
- 新增 [`README.zh.md`](./README.zh.md)：与英文版一一对应，涵盖流程、目录布局、
  同步、Microsoft Learn、工具、配置、HTTP 接口、归属、语言与限制。
- 英文 `README.md` 顶部加入 `English | [中文](./README.zh.md)` 互链。
- `package.json` 的 `files` 现在也包含中文说明，打包不会漏。

### 安装

```bash
dsh plugin add https://github.com/SiriusWJ/dsh-dotnet-skills
```

或在 DSH 的 **插件 → 添加插件** 中填入仓库地址，安装后在 **插件 → 已安装** 里配置刷新频率与最大推荐条数。

### 兼容性
- 版本：`dsh-dotnet-skills@2.2.0`
- 依赖：`@deepseek-ai/schemastery ^3.19.0`
- 已验证：`node test/smoke.mjs`（事实采集、模型输出解析、归属保护）、
  `node test/layout.mjs`（双份副本、目录同步、清空）
