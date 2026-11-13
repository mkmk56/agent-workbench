# UI 重设计稿 · Astryx

这是 agent-workbench v0.1 的 UI 重设计提案与静态高保真稿，不是正式 GUI 工程。

## 查看

直接双击或用浏览器打开：

```
design/ui-redesign-astrxy/mockups/index.html
```

不需要构建、不需要安装依赖，不加载外部字体或网络资源。

- 右上角“切换主题”在浅色/深色之间切换。
- 也可以用 `tasks.html#dark`、`task-detail.html#light` 直接打开指定主题。
- 5 个页面分别为：任务列表、任务详情 + 实时日志、派发新任务、设置、关于。

## 文件

```
mockups/
  index.html          设计索引、色板、约束、Astryx 组件对应
  tasks.html          任务列表
  task-detail.html    任务详情 + 实时日志
  dispatch.html       派发新任务
  settings.html       设置
  about.html          关于
  mockups.css         共享品牌 token 与组件样式
  mockups.js          仅主题切换
  assets/             品牌 SVG 预览副本
```

## 设计说明

完整方案见 `docs/UI_REDESIGN_ASTRYX.md`：spike 原型批评、Astryx 适配结论、token 映射、逐屏说明、与 spike 的对照、不做什么、待确认事项。

## 品牌资产

`mockups/assets/` 中的 SVG 来自 `design/brand-icon` @ `62957d8` 的已批准品牌资产，仅用于预览。正式 GUI 工程应合并或复制 `assets/branding/`，不要重画图标或手工排字标。

## 状态

本地设计分支 `design/ui-redesign-astrxy`，未推送。`src/` 与 `spike/electron` 未改动。