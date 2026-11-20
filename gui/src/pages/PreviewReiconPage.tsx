import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronDown,
  CircleAlert,
  Files,
  History,
  Inbox,
  Info,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Power,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  UserRound,
} from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle as ReAlertCircle,
  Archive as ReArchive,
  ArchiveUp as ReArchiveUp,
  ArrowLeft as ReArrowLeft,
  ChevronDown as ReChevronDown,
  Files as ReFiles,
  History as ReHistory,
  Inbox as ReInbox,
  InfoCircle as ReInfo,
  Layout as ReLayout,
  MessageSquare as ReMessageSquare,
  Moon as ReMoon,
  Plus as RePlus,
  Power as RePower,
  Refresh as ReRefresh,
  Save as ReSave,
  Settings as ReSettings,
  SidebarLeft as ReSidebarLeft,
  User as ReUser,
} from 'reicon-react';
import appMark from '@brand/source/icon-master.svg';
import claudeMark from '../assets/sidebar/claude-mark.png';
import dshMark from '../assets/sidebar/dsh-mark.png';
import museMark from '../assets/sidebar/muse-mark.png';
import '../styles/preview-reicon.css';

/**
 * Isolated Lucide ⇄ Reicon comparison page (Phase 4 follow-up, preview only).
 *
 * Route: #/preview/reicon — not linked from the nav rail and not reachable
 * from any production screen. The page is lazy-loaded in App.tsx, so
 * reicon-react stays in its own chunk and the production chat UI keeps using
 * lucide-react untouched. Nothing here is wired to the engine: both panes are
 * static visual mocks of the Phase 4 chat sidebar + chat settings page, built
 * from the same production class names so the comparison is like-for-like.
 */

type ReiconWeight = 'Outline' | 'Filled';

interface GlyphProps {
  size?: number;
  className?: string;
}

type Glyph = (props: GlyphProps) => ReactNode;

type GlyphKey =
  | 'chats'
  | 'workbench'
  | 'history'
  | 'files'
  | 'inbox'
  | 'theme'
  | 'settings'
  | 'help'
  | 'filter'
  | 'collapse'
  | 'expand'
  | 'archive'
  | 'restore'
  | 'newSession'
  | 'user'
  | 'refresh'
  | 'power'
  | 'save'
  | 'back'
  | 'alert';

type Pack = Record<GlyphKey, Glyph>;

/** The icon set the app ships today (lucide-react 1.72.0). */
const LUCIDE_PACK: Pack = {
  chats: (props) => (
    <MessagesSquare size={props.size ?? 22} strokeWidth={1.8} className={props.className} aria-hidden="true" />
  ),
  workbench: (props) => (
    <LayoutDashboard size={props.size ?? 22} strokeWidth={1.8} className={props.className} aria-hidden="true" />
  ),
  history: (props) => (
    <History size={props.size ?? 22} strokeWidth={1.8} className={props.className} aria-hidden="true" />
  ),
  files: (props) => (
    <Files size={props.size ?? 22} strokeWidth={1.8} className={props.className} aria-hidden="true" />
  ),
  inbox: (props) => (
    <Inbox size={props.size ?? 22} strokeWidth={1.8} className={props.className} aria-hidden="true" />
  ),
  theme: (props) => (
    <Moon size={props.size ?? 16} className={props.className} aria-hidden="true" />
  ),
  settings: (props) => (
    <SettingsIcon size={props.size ?? 16} className={props.className} aria-hidden="true" />
  ),
  help: (props) => (
    <Info size={props.size ?? 16} className={props.className} aria-hidden="true" />
  ),
  filter: (props) => (
    <ChevronDown size={props.size ?? 15} className={props.className} aria-hidden="true" />
  ),
  collapse: (props) => (
    <PanelLeftClose size={props.size ?? 15} className={props.className} aria-hidden="true" />
  ),
  expand: (props) => (
    <PanelLeftOpen size={props.size ?? 12} className={props.className} aria-hidden="true" />
  ),
  archive: (props) => (
    <Archive size={props.size ?? 13} className={props.className} aria-hidden="true" />
  ),
  restore: (props) => (
    <ArchiveRestore size={props.size ?? 13} className={props.className} aria-hidden="true" />
  ),
  newSession: (props) => (
    <Plus size={props.size ?? 15} className={props.className} aria-hidden="true" />
  ),
  user: (props) => (
    <UserRound size={props.size ?? 14} strokeWidth={2} className={props.className} aria-hidden="true" />
  ),
  refresh: (props) => (
    <RefreshCw size={props.size ?? 14} className={props.className} aria-hidden="true" />
  ),
  power: (props) => (
    <Power size={props.size ?? 12} className={props.className} aria-hidden="true" />
  ),
  save: (props) => (
    <Save size={props.size ?? 14} className={props.className} aria-hidden="true" />
  ),
  back: (props) => (
    <ArrowLeft size={props.size ?? 14} className={props.className} aria-hidden="true" />
  ),
  alert: (props) => (
    <CircleAlert size={props.size ?? 14} className={props.className} aria-hidden="true" />
  ),
};

/** The pilot set (reicon-react 1.2.6). Same slots, Reicon equivalents. */
function reiconPack(weight: ReiconWeight): Pack {
  return {
    chats: (props) => (
      <ReMessageSquare size={props.size ?? 22} weight={weight} className={props.className} aria-hidden="true" />
    ),
    workbench: (props) => (
      <ReLayout size={props.size ?? 22} weight={weight} className={props.className} aria-hidden="true" />
    ),
    history: (props) => (
      <ReHistory size={props.size ?? 22} weight={weight} className={props.className} aria-hidden="true" />
    ),
    files: (props) => (
      <ReFiles size={props.size ?? 22} weight={weight} className={props.className} aria-hidden="true" />
    ),
    inbox: (props) => (
      <ReInbox size={props.size ?? 22} weight={weight} className={props.className} aria-hidden="true" />
    ),
    theme: (props) => (
      <ReMoon size={props.size ?? 16} weight={weight} className={props.className} aria-hidden="true" />
    ),
    settings: (props) => (
      <ReSettings size={props.size ?? 16} weight={weight} className={props.className} aria-hidden="true" />
    ),
    help: (props) => (
      <ReInfo size={props.size ?? 16} weight={weight} className={props.className} aria-hidden="true" />
    ),
    filter: (props) => (
      <ReChevronDown size={props.size ?? 15} weight={weight} className={props.className} aria-hidden="true" />
    ),
    collapse: (props) => (
      <ReSidebarLeft size={props.size ?? 15} weight={weight} className={props.className} aria-hidden="true" />
    ),
    expand: (props) => (
      <ReSidebarLeft
        size={props.size ?? 12}
        weight={weight}
        className={props.className}
        style={{ transform: 'rotate(180deg)' }}
        aria-hidden="true"
      />
    ),
    archive: (props) => (
      <ReArchive size={props.size ?? 13} weight={weight} className={props.className} aria-hidden="true" />
    ),
    restore: (props) => (
      <ReArchiveUp size={props.size ?? 13} weight={weight} className={props.className} aria-hidden="true" />
    ),
    newSession: (props) => (
      <RePlus size={props.size ?? 15} weight={weight} className={props.className} aria-hidden="true" />
    ),
    user: (props) => (
      <ReUser size={props.size ?? 14} weight={weight} className={props.className} aria-hidden="true" />
    ),
    refresh: (props) => (
      <ReRefresh size={props.size ?? 14} weight={weight} className={props.className} aria-hidden="true" />
    ),
    power: (props) => (
      <RePower size={props.size ?? 12} weight={weight} className={props.className} aria-hidden="true" />
    ),
    save: (props) => (
      <ReSave size={props.size ?? 14} weight={weight} className={props.className} aria-hidden="true" />
    ),
    back: (props) => (
      <ReArrowLeft size={props.size ?? 14} weight={weight} className={props.className} aria-hidden="true" />
    ),
    alert: (props) => (
      <ReAlertCircle size={props.size ?? 14} weight={weight} className={props.className} aria-hidden="true" />
    ),
  };
}

const MARKS: Record<string, string> = {
  muse: museMark,
  claude: claudeMark,
  dsh: dshMark,
};

interface ChatPreview {
  name: string;
  agents: string[];
  preview: string;
  time: string;
  unread: number;
  needsMuse?: boolean;
  /** Forces the hover-only archive chip visible, so it can be compared. */
  forceHover?: boolean;
}

const CHATS: ChatPreview[] = [
  {
    name: 'Muse 派发',
    agents: ['muse', 'claude', 'dsh'],
    preview: 'Muse：Phase 4 已部署并验收通过，Reicon 预览已解锁。',
    time: '3 分钟',
    unread: 0,
    needsMuse: true,
  },
  {
    name: 'REA Phase 4 验收',
    agents: ['claude', 'dsh'],
    preview: 'Claude：部署记录已逐项复核，全部一致。',
    time: '12 分钟',
    unread: 2,
    forceHover: true,
  },
  {
    name: 'GUI 图标试点',
    agents: ['muse', 'dsh'],
    preview: '先核实 npm 上 reicon-react 的包名与版本再安装。',
    time: '1 小时',
    unread: 0,
  },
];

const WAKE_ROWS = [
  { agent: 'Claude', on: true, kind: 'mention · reply', today: 3, failures: 0 },
  { agent: 'dsh', on: true, kind: 'mention', today: 1, failures: 0 },
  { agent: 'Muse', on: false, kind: '—', today: 0, failures: 2 },
];

const MATRIX: Array<{ key: GlyphKey; label: string }> = [
  { key: 'chats', label: '导航 · 群聊' },
  { key: 'workbench', label: '导航 · 工作台' },
  { key: 'history', label: '导航 · 任务记录' },
  { key: 'files', label: '导航 · 文件' },
  { key: 'inbox', label: '导航 · 收件箱' },
  { key: 'settings', label: '导航 · 设置' },
  { key: 'help', label: '导航 · 帮助' },
  { key: 'theme', label: '导航 · 主题' },
  { key: 'filter', label: '侧栏 · 筛选' },
  { key: 'collapse', label: '侧栏 · 收起' },
  { key: 'expand', label: '侧栏 · 展开' },
  { key: 'archive', label: '会话 · 归档' },
  { key: 'restore', label: '会话 · 恢复' },
  { key: 'newSession', label: '会话 · 新建' },
  { key: 'user', label: '会话 · 用户头像' },
  { key: 'refresh', label: '设置 · 刷新' },
  { key: 'power', label: '设置 · 唤醒开关' },
  { key: 'save', label: '设置 · 保存' },
  { key: 'back', label: '设置 · 返回' },
  { key: 'alert', label: '设置 · 错误提示' },
];

function Rail({ pack }: { pack: Pack }) {
  const entries: Array<{ key: GlyphKey; label: string; selected?: boolean }> = [
    { key: 'chats', label: '群聊', selected: true },
    { key: 'workbench', label: '工作台' },
    { key: 'history', label: '任务记录' },
    { key: 'files', label: '文件' },
    { key: 'inbox', label: '收件箱' },
  ];

  return (
    <div className="nav-rail rp-rail" aria-label="全局导航（预览）">
      <span className="nav-rail__mark">
        <img src={appMark} alt="" draggable={false} />
        <span className="nav-rail__wordmark">muse</span>
      </span>
      {entries.map((entry) => (
        <span
          key={entry.key}
          className={`nav-rail__item${entry.selected === true ? ' is-selected' : ''}`}
          title={entry.label}
        >
          {pack[entry.key]({ size: 22 })}
        </span>
      ))}
      <span className="nav-rail__spacer" />
      <div className="nav-rail__bottom">
        <span className="nav-rail__engine" title="引擎在线">
          <span className="nav-rail__engine-dot nav-rail__engine-dot--success" />
        </span>
        <span className="nav-rail__item" title="切换主题">
          {pack.theme({ size: 16 })}
        </span>
        <span className="nav-rail__item" title="设置">
          {pack.settings({ size: 16 })}
        </span>
        <span className="nav-rail__item" title="帮助">
          {pack.help({ size: 16 })}
        </span>
      </div>
    </div>
  );
}

function SidebarMock({ pack, selected }: { pack: Pack; selected: number }) {
  return (
    <aside className="chat-sidebar rp-sidebar" aria-label="会话列表（预览）">
      <div className="chat-sidebar__head">
        <span className="chat-sidebar__filter">
          全部会话
          {pack.filter({ size: 15 })}
        </span>
        <span className="chat-sidebar__collapse" title="收起会话列表">
          {pack.collapse({ size: 15 })}
        </span>
      </div>

      <div className="chat-list">
        {CHATS.map((chat, index) => {
          const isSelected = index === selected;
          return (
            <div
              key={chat.name}
              className={`chat-item-wrap${isSelected ? ' is-selected' : ''}${chat.forceHover === true ? ' rp-force-hover' : ''}`}
            >
              <div className={`chat-item${isSelected ? ' is-selected' : ''}`}>
                <span className="chat-item__top">
                  <span className="chat-item__avatars">
                    {chat.agents.map((agent) => (
                      <span key={agent} className={`chat-item__avatar chat-item__avatar--${agent}`}>
                        {MARKS[agent] != null ? <img src={MARKS[agent]} alt="" draggable={false} /> : agent.slice(0, 1)}
                      </span>
                    ))}
                    <span className="chat-item__avatar chat-item__avatar--user">
                      {pack.user({ size: 14 })}
                    </span>
                  </span>
                  <span className="chat-item__name">
                    {chat.needsMuse === true && <span className="chat-item__dot" aria-label="等 Muse 回复" />}
                    {chat.name}
                  </span>
                  <span className="chat-item__time">{chat.time}</span>
                  {chat.unread > 0 && !isSelected && (
                    <span className="chat-item__unread-slot">
                      <span className="chat-item__unread">{chat.unread}</span>
                    </span>
                  )}
                </span>
                <span className="chat-item__preview">{chat.preview}</span>
              </div>
              <span className="chat-item__archive" title="归档群聊">
                {pack.archive({ size: 13 })}
              </span>
            </div>
          );
        })}
      </div>

      <div className="chat-sidebar__new">
        <span className="chat-sidebar__new-session">
          {pack.newSession({ size: 15 })}
          新建会话
        </span>
      </div>

      <span className="chat-sidebar__sash-collapse" aria-hidden="true">
        {pack.collapse({ size: 12 })}
      </span>
    </aside>
  );
}

function SettingsMock({ pack }: { pack: Pack }) {
  return (
    <section className="chat-settings-page rp-settings" aria-label="群聊设置（预览）">
      <header className="page-head rp-settings__head">
        <div className="page-head__text">
          <h1>群聊设置</h1>
          <p>Muse 派发</p>
        </div>
        <div className="chat-settings-page__actions">
          <span className="btn btn-ghost btn-sm">
            {pack.back({ size: 14 })}
            返回群聊
          </span>
          <span className="btn btn-secondary btn-sm">
            {pack.refresh({ size: 14 })}
            刷新
          </span>
        </div>
      </header>

      <div className="chat-settings-page__grid">
        <section className="chat-settings-card" aria-label="群资料">
          <h2 className="chat-settings-card__title">群资料</h2>
          <label className="chat-settings-field">
            <span>群名</span>
            <input type="text" value="Muse 派发" readOnly tabIndex={-1} aria-label="群名（预览）" />
          </label>
          <span className="btn btn-primary btn-sm rp-static-btn">
            {pack.save({ size: 14 })}
            保存描述与公告
          </span>
          <p className="chat-settings-card__hint">存在 chats.settings（JSON）里，写入失败会直接报错。</p>
          <p className="chat-settings-page__error" role="note">
            {pack.alert({ size: 13 })}
            这是错误提示样式占位，不是真实错误。
          </p>
        </section>

        <section className="chat-settings-card" aria-label="唤醒设置">
          <h2 className="chat-settings-card__title">唤醒设置（按 Agent）</h2>
          <ul className="chat-settings-wake">
            {WAKE_ROWS.map((row) => (
              <li key={row.agent} className="chat-settings-wake__row">
                <span className="chat-settings-wake__name">{row.agent}</span>
                <span className={`chat-settings-wake__switch${row.on ? ' is-on' : ''}`} aria-hidden="true">
                  {pack.power({ size: 12 })}
                  {row.on ? '已开启' : '已关闭'}
                </span>
                <dl className="chat-settings-wake__meta">
                  <div>
                    <dt>唤醒类型</dt>
                    <dd>{row.kind}</dd>
                  </div>
                  <div>
                    <dt>今日 / 失败</dt>
                    <dd>
                      {row.today} 次 / {row.failures}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
          <p className="chat-settings-card__hint">check-in 间隔是 Agent 级设置，这里只读。</p>
        </section>
      </div>
    </section>
  );
}

function Pane({
  tag,
  title,
  meta,
  pack,
  selected,
  points,
}: {
  tag: string;
  title: string;
  meta: string;
  pack: Pack;
  selected: number;
  points: string[];
}) {
  return (
    <section className="rp-pane" aria-label={`${title} 预览`}>
      <header className="rp-pane__head">
        <span className="rp-pane__tag">{tag}</span>
        <div className="rp-pane__title">
          <h2>{title}</h2>
          <p>{meta}</p>
        </div>
      </header>

      <div className="rp-frame-row">
        <div className="rp-frame">
          <Rail pack={pack} />
          <SidebarMock pack={pack} selected={selected} />
        </div>
        <ul className="rp-points">
          {points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </div>

      <SettingsMock pack={pack} />
    </section>
  );
}

export function PreviewReiconPage() {
  const [weight, setWeight] = useState<ReiconWeight>('Outline');
  const [selected, setSelected] = useState(0);
  const reicon = useMemo(() => reiconPack(weight), [weight]);
  const outlinePack = useMemo(() => reiconPack('Outline'), []);
  const filledPack = useMemo(() => reiconPack('Filled'), []);

  return (
    <section className="rp-page" aria-label="Reicon 图标对比预览">
      <header className="rp-head">
        <div className="rp-head__text">
          <p className="rp-eyebrow">Preview · 独立路由 #/preview/reicon · 不进入生产导航</p>
          <h1>Lucide vs Reicon 图标对比</h1>
          <p className="rp-lede">
            同一套页面结构：左侧是现有 lucide-react 1.72.0，右侧是试点 reicon-react 1.2.6。
            两边共用 Phase 4 的群会话侧栏与群设置页类名，只有图标实现不同。哑光黑配色与聊天气泡色未改动。
          </p>
        </div>
        <div className="rp-controls">
          <div className="rp-control">
            <span className="rp-control__label">Reicon 字重</span>
            <div className="rp-seg" role="group" aria-label="Reicon 字重">
              {(['Outline', 'Filled'] as ReiconWeight[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={`rp-seg__btn${weight === option ? ' is-active' : ''}`}
                  aria-pressed={weight === option}
                  onClick={() => setWeight(option)}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="rp-control">
            <span className="rp-control__label">侧栏选中行</span>
            <div className="rp-seg" role="group" aria-label="侧栏选中行">
              {CHATS.map((chat, index) => (
                <button
                  key={chat.name}
                  type="button"
                  className={`rp-seg__btn${selected === index ? ' is-active' : ''}`}
                  aria-pressed={selected === index}
                  onClick={() => setSelected(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <p className="rp-note" role="note">
        以下是静态视觉对照，不是可操作界面（按钮、输入框都是占位）。选中态、未读徽标、悬停归档钮都是 Phase 4
        的真实样式；生产界面的图标与依赖没有改动，lucide-react 仍然保留。
      </p>

      <div className="rp-compare">
        <Pane
          tag="A · 现状"
          title="lucide-react 1.72.0"
          meta="22 / 15 / 14 / 13px · 1.8–2 描边"
          pack={LUCIDE_PACK}
          selected={selected}
          points={[
            '描边图标，圆角端点，24 栅格。',
            '侧栏选中态：accent 填充块 + on-accent 描边图标。',
            '同一族图标线宽一致，小尺寸也保持 2px 描边。',
          ]}
        />
        <Pane
          tag="B · 试点"
          title={`reicon-react 1.2.6 · ${weight}`}
          meta={`2676 图标 · 当前 ${weight} · 默认 1.5 描边`}
          pack={reicon}
          selected={selected}
          points={[
            'Outline 多为 evenodd 实心轮廓，不是统一描边；Filled 是实心剪影。',
            '选中态同样吃 on-accent 单色，Filled 时整块更“实”。',
            '两套图标同为 24 栅格，尺寸沿用现有 22/15/14/13px。',
          ]}
        />
      </div>

      <section className="rp-matrix" aria-label="图标逐项对照">
        <header className="rp-matrix__head">
          <h2>逐项对照（20px）</h2>
          <p>
            同一个用途位，三列分别是现有 lucide、reicon Outline、reicon Filled。Filled 列固定取 Filled，
            不随上方字重切换，方便直接看填充款差异。
          </p>
        </header>
        <table className="rp-matrix__table">
          <thead>
            <tr>
              <th scope="col">用途</th>
              <th scope="col">lucide-react</th>
              <th scope="col">reicon Outline</th>
              <th scope="col">reicon Filled</th>
            </tr>
          </thead>
          <tbody>
            {MATRIX.map((row) => (
              <tr key={row.key}>
                <th scope="row">{row.label}</th>
                <td>{LUCIDE_PACK[row.key]({ size: 20 })}</td>
                <td>{outlinePack[row.key]({ size: 20 })}</td>
                <td>{filledPack[row.key]({ size: 20 })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </section>
  );
}