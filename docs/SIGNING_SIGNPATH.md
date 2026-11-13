# SignPath Foundation 签名资格核查与申请准备

> 核查日期：**2026-11-13**
> 依据：SignPath Foundation 官方页面与条款（`https://signpath.org/terms`、`https://signpath.org/about`、`https://signpath.org/apply`）及 SignPath 文档中的 GitHub 集成说明（`https://docs.signpath.io/trusted-build-systems/github`），于 2026-11-13 经系统代理 `127.0.0.1:7897` 访问核对。
> 决定：采用 **SignPath Foundation 免费开源签名计划**。使用该计划时证书签发给 SignPath Foundation，因此**发布者显示为 “SignPath Foundation”**，不是个人姓名；用户已知悉并接受。
> 本文件只做资格核查与申请准备，**不代替用户提交申请**。

---

## 1. 结论摘要

**基本资格方向符合，但当前不建议立即提交申请。**

- 已满足 / 可快速满足：公开仓库、MIT 许可证（本次新增）、功能文档、Windows NSIS 安装包产物、卸载能力、项目非商业。
- 主要阻断项：
  1. 没有可追溯的 CI 构建：现有 `v0.0.2` 是本地未提交工作区构建，tag 指向与产物不一致，不能证明“二进制来自仓库源码”。
  2. 缺少项目主页上的 **Code signing policy**（SignPath 条款明确要求在首页/下载页使用该标题并列出角色与隐私政策）。
  3. 缺少隐私政策/数据流说明（任务提示词会交给用户配置的 AI 执行器与外部服务）。
  4. 尚未配置 GitHub 可信构建系统（GitHub App + Actions 上传 artifact + SignPath 提交签名）。
  5. 产物产品名仍是 `AgentWorkbenchSpike`，不符合“产品名与项目名一致”的元数据要求。
  6. 无法核实用户 GitHub / SignPath 账号已启用 MFA（条款要求）。
- 主要不确定性：**项目信誉**。官方条款明确说明，对可执行程序要求“一定可验证的声誉”，并保留拒绝权。本仓库 2026-11-12 创建、0 star / 0 fork、仅一个测试 Release，信誉证据很弱，审核可能要求补充或直接拒绝。
- 建议：先完成第 5 节阻断项，产出一个**由 CI 从 tag 构建、资产完整、可追溯的干净 Release**，补齐 Code signing policy 与隐私说明后，再由用户本人提交申请。是否等待更多使用记录以提高通过率，由用户决定。

---

## 2. 官方资格条件逐项核对

状态说明：满足 / 待补 / 不满足 / 无法核实 / 风险。

| # | 官方条件（SignPath Foundation terms） | 本项目现状 | 状态 |
|---|---|---|---|
| 1 | 无恶意软件或潜在不受欢迎程序 | 项目是本地 AI 任务工作台，不含恶意代码；但具备“远程派单 → 本机执行 AI CLI（含完全权限模式）”的能力，需在申请材料中如实说明安全模型。 | 满足（需说明） |
| 2 | 使用 OSI 认可的开源许可证，且所有组件无商业双许可 | 2026-11-13 新增根目录 MIT `LICENSE`（Copyright (c) 2026 mkmk56）；项目无付费版/商业双许可。第三方 AI 服务是用户自行配置的外部依赖，不改变项目许可证。GitHub 许可证 API 已返回 `MIT`。 | 满足 |
| 3 | 不含专有、非开源组件（系统库除外） | 项目源码为 MIT；`package-lock.json` 中 95 个依赖的许可证字段均为 MIT / ISC / BSD-2 / BSD-3，无未知项。`claude`、`dsh` 是用户本机另行安装的外部执行器，**不得打包进安装包**；Electron/Node 属开源运行时。正式打包仍需复核 `extraResources`，确保未混入专有二进制。 | 基本满足（打包前复核） |
| 4 | 项目处于活跃维护状态 | 单人维护，2026-11-13 仍在开发；但仓库创建仅 1 天，维护历史很短。 | 形式满足（证据弱） |
| 5 | 已以“待签名形态”发布 | 公开 Release `v0.0.2` 含 NSIS 安装包、blockmap、`latest.yml`，形态就是待签名的 Windows 安装包。但该 Release 由未提交工作区构建，tag `v0.0.2` 指向 `581725b`，产物与源码不可追溯。 | 待补（有发布，但不可追溯） |
| 6 | 功能在下载页或应用商店有说明 | `README.md` 描述了项目定位、工具、部署与使用方式。 | 满足 |
| 7 | 不含黑客工具（不提供识别/利用漏洞或绕过执行环境安全措施的功能） | 不含漏洞扫描、利用、绕过安全机制的功能。AI 执行器以用户显式授权的方式运行，属于开发自动化工具。 | 满足 |
| 8 | 尊重用户隐私与安全；收集/传输数据需隐私政策、安装时展示、可关闭 | 无内置遥测；token、日志、任务数据保存在本机。但任务提示词与上下文会交给用户配置的 AI 执行器，并可能由其发送到相应 AI 服务；公网入口通过隧道暴露 MCP。**目前没有隐私政策与数据流说明**。 | 待补 |
| 9 | 系统修改需明确告知 | 安装器为 per-user NSIS；自动更新会替换应用文件。需要在安装/更新界面明确告知。 | 待补（实现时确认） |
| 10 | 提供卸载 | NSIS 安装包自带卸载程序；spike 已验证覆盖安装/卸载流程。 | 满足 |
| 11 | 团队成员对 SignPath 与代码仓库启用 MFA | 无法从仓库核实用户账号状态。 | 无法核实（用户待办） |
| 12 | 明确作者 / 审核者 / 批准者角色，非提交者的变更需审核，每次签名需批准 | 当前为单人维护，可由同一人承担三个角色，但必须在 Code signing policy 中明确写出。 | 待补（文档） |
| 13 | 项目首页/下载页必须标注 “Code signing policy”，含 SignPath 指定措辞、角色成员、隐私政策 | 当前 README 没有该小节。 | 不满足（阻断项） |
| 14 | 产物元数据：产品名统一为项目名，版本一致；使用 SignPath 文件元数据限制 | spike 产物名为 `AgentWorkbenchSpike`，版本 0.0.2；正式工程需改为项目正式名称并固定版本口径。 | 待补（阻断项） |
| 15 | 使用可信构建系统；OSS 项目前置任务须在 GitHub 托管 runner 上执行；每次发布人工批准 | 当前为本地构建；尚无 GitHub Actions 发布流水线与 SignPath GitHub App/connector。 | 不满足（阻断项） |
| 16 | 可验证的声誉；SignPath 保留拒绝权 | 仓库 2026-11-12 创建，0 star / 0 fork，仅一个测试 Release；公开使用记录极少。 | 风险（可能被拒） |
| 17 | 只签自己的项目与二进制；团队拥有源码与构建脚本 | 仓库由用户 `mkmk56` 所有；正式流水线应只签名本仓库构建的 NSIS 安装包，不为上游二进制单独签名。 | 满足（流水线落地后） |
| 18 | 接受技术约束，不绕过；每个 Release 人工批准 | 需要在流程中设置 Approver，并保留签名请求审批记录。 | 待补（流程） |

### 对“现有 v0.0.2 是否算有效发布历史”的判断

**形式上算一次公开 Release，但不能作为 SignPath 所需的“可追溯发布”证据。**

- 有利：它是公开、非 draft、非 prerelease 的 Windows NSIS 安装包，形态与最终要签名的产物一致；满足了“已经发布”的字面条件。
- 不利：产物由本地未提交工作区构建，tag 指向的提交与构建内容不一致；没有 CI 日志、artifact 上传记录或源码 provenance。SignPath 的 GitHub 可信构建会校验“构建确实由 GitHub workflow 执行、artifact 先上传到 GitHub”，现有 Release 无法通过这类校验。
- 结论：可以把它作为“项目已有公开版本”的辅助材料，但**不要把它当作申请的核心发布证据**。申请前应重新用 CI 从 tag 构建一个干净版本（例如 `v0.1.0`），资产齐全并保留构建记录。

---

## 3. 申请所需材料

由用户本人提交时，建议准备：

1. **项目基本信息**：项目名 `agent-workbench`、仓库 URL `https://github.com/mkmk56/agent-workbench`、项目简介（本地 MCP 引擎 + Electron 桌面 GUI，用于在本机调度 Claude Code / DeepSeek Harness 执行任务）。
2. **许可证**：MIT（根目录 `LICENSE`）。
3. **公开 Release 链接**：现有 `v0.0.2` 可提供；更推荐提供新构建的可追溯版本链接。
4. **构建系统**：GitHub Actions（`windows-latest`），计划使用 SignPath 官方 `signpath/github-action-submit-signing-request@v3`。
5. **签名产物类型**：Windows NSIS `.exe` 安装包（以及后续需要签名的应用 `.exe`）。
6. **联系人**：用户本人的联系邮箱（申请表单必填；不要在仓库中公开敏感个人信息）。
7. **Code signing policy**：按第 6 节草稿放入 README 首页/下载页。
8. **隐私政策 / 数据流说明**：说明本地数据、外部 AI 服务、无遥测、token 加密存储等。
9. **团队角色**：作者、审核者、批准者名单（当前均为 `mkmk56`）。
10. **MFA 确认**：GitHub 与 SignPath 账号均已启用多因素认证。
11. **安全模型说明**：仅监听回环地址、Bearer Token、任务执行器由用户显式安装与授权、公网入口由用户自行配置隧道。申请时如实说明“可远程派单到本机执行 AI CLI”的能力，避免审核误解。

---

## 4. 申请与接入步骤（获批后执行）

1. **用户注册并提交申请**：在 `https://signpath.org/apply` 填写表单（HubSpot 表单），提供第 3 节材料。此步骤必须由用户本人完成，本会话不代为提交。
2. **等待审核**：SignPath 可能要求补充项目说明、发布链接或安全说明；项目信誉是主要不确定性。
3. **获批后创建组织/项目**：在 SignPath 控制台确认 organization、project、signing policy、artifact configuration。
4. **配置可信构建**：
   - 使用预定义 Trusted Build System **GitHub.com**，将其加入组织并链接到项目；
   - 安装 **SignPath GitHub App** 并授权目标仓库；
   - 创建 CI 用户/API token，存入 GitHub Actions Secrets（例如 `SIGNPATH_API_TOKEN`）。
5. **配置 artifact configuration**：
   - 以 NSIS 安装包（PE 文件）为签名对象；
   - 设置产品名与版本的文件元数据限制，确保产品名为正式项目名、版本在各构建中一致；
   - 如安装包内还包含需要签名的应用 exe，按 SignPath 的嵌套文件配置处理；上游开源二进制可保持未签名。
6. **GitHub Actions 发布流水线**（示意，具体参数以控制台生成的配置为准）：

   ```yaml
   name: release
   on:
     push:
       tags: ["v*"]
   jobs:
     build-sign-release:
       runs-on: windows-latest
       permissions:
         contents: write
         actions: read
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 22
         - run: npm ci
         - run: npm run dist:win   # 以正式工程脚本为准
         - name: Upload unsigned installer
           id: upload-unsigned
           uses: actions/upload-artifact@v7
           with:
             path: release/*.exe
         - name: Submit signing request
           uses: signpath/github-action-submit-signing-request@v3
           with:
             api-token: ${{ secrets.SIGNPATH_API_TOKEN }}
             organization-id: ${{ secrets.SIGNPATH_ORGANIZATION_ID }}
             project-slug: agent-workbench
             signing-policy-slug: release-signing
             github-artifact-id: ${{ steps.upload-unsigned.outputs.artifact-id }}
             wait-for-completion: true
             output-artifact-directory: signed
         - name: Publish signed release
           run: gh release create "${{ github.ref_name }}" signed/*.exe signed/*.blockmap signed/latest.yml
           env:
             GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
   ```

   > 说明：以上仅为流程示意，不是可直接使用的最终配置；正式实现时必须校验资产完整性（安装包、blockmap、`latest.yml`），并从签名后的目录发布。
   >
   > **签名与自动更新的关键顺序**：Authenticode 签名会改变安装包字节，electron-builder 在打包时生成的 `latest.yml`（含安装包 sha512）与 blockmap 必须在签名后重新生成/校验，否则 electron-updater 会因哈希不匹配拒绝更新。推荐在 electron-builder 的签名钩子中提交 SignPath 签名，再据签名后的产物生成 `latest.yml` 与 blockmap；若只能后置签名，则必须重新生成并验证二者。另需把 `app-update.yml` / 打包配置中的 `publisherName` 设为证书实际主体（预计为 `SignPath Foundation`），并实测升级验签。

7. **每次发布人工批准**：SignPath 签名请求进入 `WaitingForApproval` 后，由 Approver 在控制台批准；保留审批记录。
8. **验证签名**：
   - `Get-AuthenticodeSignature .\AgentWorkbench-Setup-x.y.z.exe` 应为 `Valid`，签名主体为 SignPath Foundation；
   - 在干净 Windows 环境验证 SmartScreen 提示与安装/卸载；
   - 验证 electron-updater 更新验签：在打包配置中设置与证书主体匹配的 `publisherName`（预计为 `SignPath Foundation`，以实际证书 Subject 为准），并实测从旧版本升级。
9. **凭据与权限**：API token 仅存于 GitHub Secrets；限制仓库写权限；启用 MFA；不在日志中输出 token。

---

## 5. 提交申请前的阻断项清单

按顺序完成：

1. [x] 推送 MIT `LICENSE`，确认 GitHub 仓库页识别为 MIT（2026-11-13 已通过 GitHub 许可证 API 核实为 `MIT`）。
2. [ ] 在 README 首页增加 **Code signing policy** 小节（使用第 6 节草稿），并补充隐私政策/数据流说明。
3. [ ] 正式 GUI 工程将产品名从 `AgentWorkbenchSpike` 改为正式名称，版本号统一。
4. [ ] 建立 GitHub Actions 构建流水线，从 tag 构建 NSIS 安装包，上传 artifact，资产齐全（安装包、blockmap、`latest.yml`）。
5. [ ] 配置 SignPath 可信构建（GitHub App、connector、项目链接、artifact configuration）。
6. [ ] 确保安装包不包含专有 `claude` / `dsh` 二进制；复核 Electron 与依赖许可证随包分发。
7. [ ] 用户启用 GitHub 2FA；获批后启用 SignPath MFA。
8. [ ] 明确三个角色（作者/审核者/批准者），当前均为 `mkmk56`。
9. [ ] 决定 `v0.0.2` 保留或删除：建议保留但标注为测试版，不作为签名构建证据；删除会丢失现有发布历史，需用户决定。
10. [ ] 产出一个干净的可追溯 Release（建议 `v0.1.0`），作为申请材料中的“已发布”证据。

> 在上述阻断项完成前提交申请，预计会被要求补充材料；项目信誉较新，仍可能被拒。是否先提交占位/咨询，由用户决定。

---

## 6. Code signing policy 草稿（待用户批准后放入 README）

> SignPath 条款要求在项目首页/下载页使用 “Code signing policy” 作为小节标题或链接，并包含指定措辞、角色成员与隐私政策。

```markdown
## Code signing policy

Free code signing provided by SignPath.io, certificate by SignPath Foundation.

- Committers and reviewers: [mkmk56](https://github.com/mkmk56)（当前为单人维护；所有变更由维护者审核）
- Approvers: [mkmk56](https://github.com/mkmk56)（每次签名请求由维护者批准）

### Privacy policy

本程序不内置遥测，不会主动向维护者或第三方传输数据。任务提示词、任务状态与日志保存在本机数据目录； token 通过操作系统凭据保护机制加密保存。

用户派发的任务会交给用户本机已安装并显式授权的 AI 执行器（Claude Code / DeepSeek Harness）处理。这些执行器可能按其自身配置，将提示词与上下文发送到用户选择的 AI 服务；是否发送、发送给谁由用户配置决定。公网访问入口由用户自行配置，默认仅监听本机回环地址并要求 Bearer Token 认证。
```

> 注意：以上隐私说明是根据当前实现与 spike 行为起草的，正式发布前需按最终数据流复核；如果后续加入遥测、崩溃上报或云端账号，必须更新本政策并在安装时展示、提供关闭选项。

---

## 7. 需要用户本人完成的事项

1. **注册 / 登录 SignPath**，在 `https://signpath.org/apply` 提交申请；提供联系邮箱与第 3 节材料。本会话不代为提交。
2. **启用 GitHub 多因素认证**（若尚未启用）；获批后为 SignPath 账号启用 MFA。
3. **确认申请时机**：是现在提交（接受可能被要求补充/被拒），还是先积累可追溯发布与使用记录后再申请。
4. **批准 README 增加 Code signing policy 与隐私说明**（可使用第 6 节草稿，需按最终实现复核）。
5. **决定 `v0.0.2` 测试 Release 的保留/删除**；建议保留并明确标注测试性质。
6. **提供/确认申请用的联系邮箱与项目对外名称**。
7. **批准正式工程接入 CI 与 SignPath**：创建 GitHub Actions、安装 SignPath GitHub App、配置 Secrets、设置 Approver。
8. **确认发布者显示名**：使用 SignPath Foundation 证书时显示 “SignPath Foundation”；用户已确认接受，无需再改。

---

## 8. 官方依据

- SignPath Foundation 条款（资格、Code of Conduct、签名政策要求）：`https://signpath.org/terms`
- SignPath Foundation 关于页面（证书签发给 SignPath Foundation）：`https://signpath.org/about`
- 申请入口：`https://signpath.org/apply`
- GitHub 可信构建与提交签名 Action：`https://docs.signpath.io/trusted-build-systems/github`
- SignPath 构建集成与 API：`https://docs.signpath.io/build-system-integration`

> 条款可能更新；提交申请前应再次打开官方页面核对。本文件记录的是 2026-11-13 的核对结果。