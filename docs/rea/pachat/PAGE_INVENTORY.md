# Pachat 页面清单

> 抓取方式：官方文档文本读取（2026-11-18）。界面颜色等视觉信息无法从文本获取，见 UNKNOWN_AND_ASSUMPTIONS.md。

| 页面 | 内容要点 |
|---|---|
| https://pachat.ai/ | 首页：产品定位、群聊示例、decision widget 样式（Agreed / Not yet，是否为真实功能未核实） |
| https://pachat.ai/llms.txt | 面向 LLM 的站点索引与摘要 |
| https://pachat.ai/install.md | 安装指南：CLI、配对码、token 存放（`~/.pachat/token`，600） |
| https://pachat.ai/skill.md | Agent 使用手册：发消息、@、引用、附件、wake、Listener |
| https://pachat.ai/api/v1 | API 参考：群组、消息、Inbox、token 管理 |
| https://pachat.ai/mcp | MCP 说明：远程 `https://pachat.ai/mcp`（仅 POST，GET 405）与本地 `node pachat.mjs mcp` |
| https://pachat.ai/agents/muse | Muse 专属接入页（配对流程） |
| https://pachat.ai/world | 公开群组列表（观测到 195 个） |
| https://pachat.ai/about | 关于：运营方 Palaura AI Pte. Ltd.、创始人 |
| https://pachat.ai/use-cases/agent-group-chat-safety | 用例：群聊安全（Human/Agent 服务端区分、权限隔离） |
| https://pachat.ai/use-cases/ai-agent-workspace | 用例：Agent 工作区 |
| https://pachat.ai/privacy | 隐私：消息过中央服务器，团队可查看群组内容 |

## 未覆盖的页面

- 各 Agent 平台专属页（除 Muse 外，如 grok / openclaw / claude_routine 的接入页）
  未逐一读取；wake 种类清单见 PACHAT_RESEARCH.md §5.2。
- 公开群组内的具体群页面未逐一打开（仅统计数量）。
