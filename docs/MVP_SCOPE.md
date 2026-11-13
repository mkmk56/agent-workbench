# agent-workbench MVP v0.1 范围说明

> 状态：已确认
> 确认日期：2026-11-13
> 决策人：用户
> 适用产品：agent-workbench 桌面版（Electron GUI + 现有 MCP 引擎）
> 分发范围：用户本人自用，并小范围分享给熟人；不做面向公众的正式推广（仓库与 Release 保持公开，用于自动更新与签名资格）
> 签名方案：**SignPath Foundation 免费开源签名**（发布者显示为 “SignPath Foundation”，用户已知悉并接受）
> 许可证：MIT（根目录 `LICENSE`，Copyright (c) 2026 mkmk56）

---

## 1. 目标与边界

MVP v0.1 的目标是把现有本地 MCP 引擎包装成可安装的 Windows 桌面应用，让用户不依赖命令行即可：

- 查看任务列表、任务详情与实时日志；
- 派发新任务、发送跟进消息、取消任务；
- 查看 claude / dsh 执行器状态；
- 启动、停止引擎并确认连接状态；
- 在 GUI 内维护 token、端口与代理设置；
- 通过自动更新升级到新版本。

技术栈为 Electron，正式 GUI 工程与 `spike/electron` 可行性验证代码分离。MCP 服务器继续作为核心引擎，负责执行器管理、任务调度、状态与日志持久化。

---

## 2. v0.1 包含

### 2.1 功能

| 模块 | 范围 |
|---|---|
| 任务列表 | 展示任务状态、执行器（claude / dsh）与用时 |
| 任务详情 + 实时日志 | 查看任务日志流；向运行中的任务发送跟进消息 |
| 派发新任务 | 选择 claude / dsh，填写 prompt，设置超时 |
| 取消任务 | 取消运行中的任务并反馈结果 |
| 智能体状态 | 展示 claude / dsh 是否可用及所用模型 |
| 引擎管理 | 启动 / 停止引擎，读取 `/health`，展示连接状态 |
| 设置 | 配置 token、端口、代理 |
| 自动更新 | 基于 GitHub Releases 的版本检查与安装 |
| 品牌 | 应用图标 + 关于页（已完成） |

### 2.2 工程基线（必须完成，不计入功能范围）

- **数据目录迁移**：数据库、任务日志、prompt 与元数据迁到 Electron `app.getPath('userData')`，不再写入安装目录。
- **凭据存储**：token 使用 Electron `safeStorage`（Windows 下走 DPAPI）加密保存，不以明文落盘，不暴露给渲染进程。
- **单实例**：应用只允许一个实例运行，避免重复启动引擎与端口冲突。
- **最小 IPC / CSP**：`contextIsolation`、`sandbox`、关闭 `nodeIntegration`；IPC 按白名单暴露；渲染层使用严格 CSP。

---

## 3. v0.1 不做

- 多项目（multi-project）管理；
- 历史统计仪表盘；
- 定时任务；
- 云同步 / 账号体系；
- 插件机制；
- macOS 打包（v0.1 只做 Windows）。

---

## 4. 签名与分发

- **签名方案：SignPath Foundation 免费开源项目签名计划。**
- **发布者名称**：使用 SignPath Foundation 证书时，文件属性/签名发布者显示为 **“SignPath Foundation”**，不是个人或项目自有名称；用户已知悉并接受。
- **前提**：公开仓库 + OSI 认可许可证（本项目采用 MIT）+ 可追溯构建 + 符合 SignPath 条款。资格核查、申请材料与阻断项见 `docs/SIGNING_SIGNPATH.md`。
- **申请状态**：尚未提交。申请须由用户本人注册并提交；当前仍有阻断项（CI 可追溯构建、Code signing policy、隐私说明、产品名统一等）。
- 自动更新仍以 GitHub Releases 为更新源；正式发布包必须资产完整（安装包、blockmap、`latest.yml`）。

---

## 5. 验收口径

v0.1 达到以下条件视为完成：

1. 第 2.1 节全部功能可在 Windows 上端到端使用；
2. 第 2.2 节工程基线全部落地，token 无明文落盘，渲染进程无法直接访问 Node/文件系统；
3. 安装包可正常安装、启动、停止引擎；正式发布版本应使用 SignPath 签名，`Get-AuthenticodeSignature` 显示有效且发布者为 “SignPath Foundation”；若 SignPath 申请尚未获批，是否临时以未签名版本发布由用户单独决定，不得在文档或界面中虚假宣称已签名；
4. 自动更新可从旧版本检查、下载并安装新版本；
5. 仅支持 Windows（x64），不承诺 macOS 可用性。

---

## 6. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-13 | 用户确认 MVP v0.1 范围（包含 / 不做 / 工程基线）；签名方案确定为 **SignPath Foundation 免费开源签名**（发布者显示 “SignPath Foundation”，用户接受）。 |
| 2026-11-13 | 同日后续决定：撤销此前的“暂不签名”口径，改用 SignPath；资格核查与申请准备见 `docs/SIGNING_SIGNPATH.md`。 |