import type {
  ChatMember,
  ChatSummary,
  EngineResult,
  PairedAgent,
} from '../types';

/**
 * REA Phase 4 §6.3 [E] — Agent 管理 data layer.
 *
 * Contract / why this module looks like this:
 *  - The engine has **no** tool that lists every paired agent. `agent_pairing_code`,
 *    `agent_pair` and `agent_revoke_token` (src/tools.js) can create / revoke rows,
 *    but nothing reads the `agents` table. The only honest source is the union of
 *    `chat_members` over the chats returned by `list_chats`, so the UI states that
 *    in one line instead of pretending to know a global inventory.
 *  - Therefore `loadPairedAgents()` asks each chat for its members. A chat whose
 *    members fail to load leaves the union *incomplete*; the failure is returned in
 *    `errors` (verbatim engine text) so the page can say the list is partial. We
 *    never invent an agent, a status, a platform or a join date.
 *  - `platform === 'muse'` / `agent_id === 'agent_muse'` is an **external** agent:
 *    Muse has no local executor in this build, so the UI must show it read-only and
 *    never offer a "启动执行器" button. The human owner row (`role === 'owner'` or
 *    `agent_id === 'agent_user'`) is read-only for the same reason (you cannot
 *    revoke yourself).
 *  - The engine has no enable/disable tool either. `agents.status` is the real,
 *    authoritative state; the only mutation that exists is token revocation, which
 *    is what "停用" maps to (documented in the page as well).
 *  - No JSX here: the module stays importable by `node --test` (no IPC at load
 *    time), so the merge/label/validation helpers are unit-tested directly.
 */

/** Shown under the list so the source of truth is never implied to be stronger. */
export const AGENT_LIST_SOURCE_NOTE =
  '来自各群成员（引擎暂无全局 Agent 列表工具）';

export const MUSE_AGENT_ID = 'agent_muse';
export const OWNER_AGENT_ID = 'agent_user';

/** Statuses that mean "this token is already gone" — nothing left to revoke. */
const REVOKED_STATUSES = new Set(['revoked', 'disabled', 'inactive', 'deactivated']);

const PLATFORM_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  dsh: 'dsh',
  muse: 'Muse',
};

const STATUS_LABELS: Record<string, string> = {
  active: '启用中',
  revoked: '已注销',
  suspended: '已暂停',
  paused: '已暂停',
  pending: '待激活',
  inactive: '已停用',
  disabled: '已停用',
};

const ROLE_LABELS: Record<string, string> = {
  owner: '所有者',
  member: '成员',
};

/**
 * Data source seam. `chat.ts` is imported lazily (see `loadPairedAgents`) so the
 * pure helpers below can be tested without the renderer IPC bridge.
 */
export interface AgentRegistryDeps {
  listChatsOnce: (includeArchived?: boolean) => Promise<EngineResult<ChatSummary[]>>;
  chatMembersOnce: (chatId: string) => Promise<EngineResult<ChatMember[]>>;
}

export interface PairedAgentSnapshot {
  agents: PairedAgent[];
  /** Number of chats the union was read from. */
  chatCount: number;
  /** Per-chat read failures; the union is incomplete when this is non-empty. */
  errors: string[];
}

export interface PairOutcome {
  agentId: string | null;
  displayName: string | null;
  /** Engine-issued agent token. Shown once: the engine never returns it again. */
  token: string | null;
}

function text(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function optionalText(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed.length > 0 ? trimmed : null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD HH:mm`; deterministic given the epoch value. */
function formatMinute(epochMs: number): string {
  const date = new Date(epochMs);
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` +
    ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  );
}

/**
 * `joined_at` arrives as epoch ms from the engine membership row, but older rows
 * may carry an ISO string or 0. 0 / empty stays null — never "now".
 */
export function toIsoTimestamp(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return new Date(value).toISOString();
  }
  const raw = text(value);
  if (raw.length === 0 || raw === '0') {
    return null;
  }
  if (/^\d+$/.test(raw)) {
    const epoch = Number(raw);
    return Number.isFinite(epoch) && epoch > 0 ? new Date(epoch).toISOString() : null;
  }
  return raw;
}

export function isExternalAgent(agent: Pick<PairedAgent, 'agent_id' | 'platform'>): boolean {
  return agent.agent_id === MUSE_AGENT_ID || agent.platform === 'muse';
}

export function isOwnerAgent(agent: Pick<PairedAgent, 'agent_id' | 'role'>): boolean {
  return agent.agent_id === OWNER_AGENT_ID || agent.role === 'owner';
}

/**
 * Read-only rows: external agents (Muse, no local executor) and the human owner
 * (the engine cannot revoke the owner token from the GUI).
 */
export function isReadOnlyAgent(
  agent: Pick<PairedAgent, 'agent_id' | 'platform' | 'role'>,
): boolean {
  return isExternalAgent(agent) || isOwnerAgent(agent);
}

/** One mutation exists: revoke the token. External/owner rows never expose it. */
export function canRevokeAgent(agent: PairedAgent): boolean {
  if (isReadOnlyAgent(agent)) {
    return false;
  }
  return !REVOKED_STATUSES.has(text(agent.status).toLowerCase());
}

/** Map one `chat_members` row; rows without an `agent_id` are dropped. */
export function toPairedAgent(member: ChatMember): PairedAgent | null {
  const agentId = text(member?.agent_id);
  if (agentId.length === 0) {
    return null;
  }
  const platform = optionalText(member?.platform);
  const displayName = text(member?.display_name) || agentId;
  return {
    agent_id: agentId,
    display_name: displayName,
    platform,
    status: text(member?.status) || 'unknown',
    role: text(member?.role) || 'member',
    color: optionalText(member?.color),
    external: isExternalAgent({ agent_id: agentId, platform }),
    joined_at: toIsoTimestamp(member?.joined_at),
  };
}

function ownerRank(agent: PairedAgent): number {
  return isOwnerAgent(agent) ? 0 : 1;
}

function compareAgents(a: PairedAgent, b: PairedAgent): number {
  const rank = ownerRank(a) - ownerRank(b);
  if (rank !== 0) {
    return rank;
  }
  const byName = a.display_name.localeCompare(b.display_name, 'zh-Hans-CN');
  if (byName !== 0) {
    return byName;
  }
  return a.agent_id.localeCompare(b.agent_id);
}

/**
 * Union of the same agent across chats: dedupe by `agent_id`, keeping the first
 * non-null color / platform / status / joined_at (the first chat that knew about
 * the agent wins), then owners first and display name ascending.
 */
export function mergePairedAgents(rows: readonly ChatMember[]): PairedAgent[] {
  const byId = new Map<string, PairedAgent>();
  for (const row of rows) {
    const agent = toPairedAgent(row);
    if (agent == null) {
      continue;
    }
    const existing = byId.get(agent.agent_id);
    if (existing == null) {
      byId.set(agent.agent_id, agent);
      continue;
    }
    byId.set(agent.agent_id, {
      ...existing,
      display_name: existing.display_name || agent.display_name,
      platform: existing.platform ?? agent.platform,
      // 'unknown' is toPairedAgent's "the row did not say" marker, so a later chat
      // that actually knows the status still fills it in.
      status:
        existing.status === 'unknown' || existing.status.length === 0
          ? agent.status
          : existing.status,
      role: existing.role || agent.role,
      color: existing.color ?? agent.color,
      joined_at: existing.joined_at ?? agent.joined_at,
    });
  }
  return [...byId.values()]
    .map((agent) => ({
      ...agent,
      // Re-derive after the merge: a later chat may be the one that knows the
      // platform, which is what makes the row external.
      external: isExternalAgent(agent),
    }))
    .sort(compareAgents);
}

export function platformLabel(platform: string | null): string {
  const key = text(platform).toLowerCase();
  if (key.length === 0) {
    return '未标注';
  }
  return PLATFORM_LABELS[key] ?? text(platform);
}

export function agentStatusLabel(status: string): string {
  const key = text(status).toLowerCase();
  if (key.length === 0) {
    return '未知';
  }
  return STATUS_LABELS[key] ?? text(status);
}

export function agentStatusTone(
  status: string,
): 'success' | 'warning' | 'error' | 'neutral' {
  const key = text(status).toLowerCase();
  if (key === 'active') {
    return 'success';
  }
  if (key === 'failed' || key === 'error') {
    return 'error';
  }
  if (key === 'pending' || key === 'suspended' || key === 'paused') {
    return 'warning';
  }
  return 'neutral';
}

export function agentRoleLabel(role: string): string {
  const key = text(role).toLowerCase();
  return ROLE_LABELS[key] ?? (text(role) || '成员');
}

/** Pairing codes expire; the page shows both the deadline and the remaining time. */
export function formatPairingExpiry(expiresAt: number, now: number): string {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    return '有效期未知';
  }
  const stamp = formatMinute(expiresAt);
  const remaining = expiresAt - now;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return `${stamp}（已过期）`;
  }
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  const span =
    hours > 0
      ? `${hours} 小时 ${restMinutes} 分`
      : minutes > 0
        ? `${minutes} 分钟`
        : '不足 1 分钟';
  return `${stamp}（剩余 ${span}）`;
}

export function formatJoinedAt(iso: string | null): string {
  const raw = text(iso);
  if (raw.length === 0) {
    return '—';
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    // Engine already formatted it; show what it said instead of guessing.
    return raw;
  }
  return formatMinute(parsed.getTime());
}

export interface PairFormInput {
  code: string;
  name: string;
  platform?: string;
}

/** Client-side guard only; the engine stays the authority on the code itself. */
export function validatePairForm(input: PairFormInput): string | null {
  if (text(input.code).length === 0) {
    return '配对码不能为空。';
  }
  if (text(input.name).length === 0) {
    return 'Agent 名称不能为空。';
  }
  if (text(input.name).length > 64) {
    return 'Agent 名称最多 64 个字符。';
  }
  if (text(input.platform).length > 32) {
    return '平台标识最多 32 个字符。';
  }
  return null;
}

/** Pull the useful fields out of `agent_pair`'s free-form result object. */
export function describePairResult(data: Record<string, unknown>): PairOutcome {
  return {
    agentId: optionalText(data?.agent_id),
    displayName: optionalText(data?.display_name) ?? optionalText(data?.name),
    token: optionalText(data?.token),
  };
}

async function defaultDeps(): Promise<AgentRegistryDeps | null> {
  // Lazy: keeps this module free of IPC imports at load time so the pure helpers
  // stay testable with `node --test`. Only reached from the renderer.
  try {
    const chat = await import('./chat');
    return { listChatsOnce: chat.listChatsOnce, chatMembersOnce: chat.chatMembersOnce };
  } catch {
    return null;
  }
}

/**
 * Union of `chat_members` over all chats (archived included: an agent paired to an
 * archived chat is still paired). Pass `deps` in tests to bypass IPC.
 */
export async function loadPairedAgents(
  deps?: AgentRegistryDeps,
): Promise<EngineResult<PairedAgentSnapshot>> {
  const io = deps ?? (await defaultDeps());
  if (io == null) {
    return { ok: false, error: 'Agent 列表数据源不可用（IPC 桥未就绪）。' };
  }
  let chats: EngineResult<ChatSummary[]>;
  try {
    chats = await io.listChatsOnce(true);
  } catch {
    return { ok: false, error: '读取群聊列表失败（主进程调用异常）。' };
  }
  if (!chats.ok) {
    return { ok: false, error: chats.error };
  }

  const results = await Promise.all(
    chats.data.map((chat) => io.chatMembersOnce(chat.chat_id)),
  );
  const rows: ChatMember[] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    if (result.ok) {
      rows.push(...result.data);
      return;
    }
    const chatId = chats.data[index]?.chat_id ?? `#${index}`;
    errors.push(`${chatId}：${result.error}`);
  });

  return {
    ok: true,
    data: { agents: mergePairedAgents(rows), chatCount: chats.data.length, errors },
  };
}