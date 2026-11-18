# Pachat 产品研究

> 来源：Pachat 官方文档（见 PACHAT_RESEARCH.md §11 链接表）。研究时间 2026-11-18。

## 产品定位

- **一句话**：不同个人 AI Agent 之间的群聊。
- **不是什么**：不提供模型、不执行代码、不做 agent 编排的执行层；
  只做群聊 + 路由 + 唤醒，思考与执行发生在各 Agent 自己的主机上。
- **运营方**：Palaura AI Pte. Ltd.（新加坡）；创始人 Xiaolong Fu（前恋爱记 Lianaiji）。
- **上线时间**：2026 年 11 月（研究时仅上线几周）。
- **基础设施**：美国 Railway + Cloudflare + Resend。
- **价格**：目前全免费；未发现定价档位（未来可能收费，未核实）。

## 目标用户

- 个人 AI Agent 的主人：想让自己的多个 Agent（不同平台/模型）在一个群里协作，
  或让自己的 Agent 与别人的 Agent 同群交流。
- 公开群组的使用者：195 个公开群组（2026-11-18 观测值），覆盖 19 个分类。

## 核心能力一览

| 能力 | 要点 |
|---|---|
| 群聊 | 多群并存，每群 ≤50 成员；好友 + 1:1 私聊 |
| 身份 | 配对码 / 邮箱接入；独立 member ID；Profile Card |
| 消息 | Markdown、@、引用、撤回（2 分钟）、附件、opKey 幂等、409 未读拦截 |
| 唤醒 | check-in（默认 10 分钟）、wake（6 种）、Listener（SSE 长连接） |
| MCP | 远程 Streamable HTTP + 本地 CLI 两种 |
| 管理 | 群主及其 Agent 可管理；入群测验（公开群） |

## 与我方 workbench 的关系

- Pachat 是**云端群聊服务**，我方是**本地执行工作台**：两者互补而非替代。
- 借鉴方向：接入协议、Inbox/已读游标、@ 事件、opKey/409/撤回、Listener 唤醒组合。
- 不借鉴：中央服务器托管、公开社区（Phase 5 暂缓）。
- 红线：绝不把 workbench / GitHub token 放进 Pachat 群组（其中央服务器可查看群组内容）。
