import { FilePenLine, Paperclip } from 'lucide-react';
import type { ChatFile } from '../lib/chat';
import {
  editedCardExtras,
  fileDisplayName,
  fileStatusOf,
  fileSummaryOf,
  isHistoricalFile,
  pathSegments,
} from '../lib/chat-files';
import { useChatFileActions } from './useChatFileActions';

/**
 * "Edited files" card — P0-5 front-end scheme B (docs/REFACTOR_PLAN.md §3.1).
 *
 * One flat row per attachment: full name/path (wrapped, never truncated),
 * change summary and status. Rows are separated by 1px lines instead of nested
 * cards (VISUAL_SCHEME.md §6: 不做卡片堆叠).
 *
 * What is real here: the file object the engine returned, merged with
 * `list_chat_files` by the caller. The chat file contract has no diff stats and
 * no "pushed" state, so the summary column reports size + kind + parse state —
 * the card never prints invented added/deleted line counts.
 */
export function EditedFilesCard({
  files,
  chatId,
  from,
}: {
  files: ChatFile[];
  chatId: string;
  /** Who attached/produced the files: decides the header wording only. */
  from: 'user' | 'agent';
}) {
  if (files.length === 0) {
    return null;
  }
  const isAgent = from === 'agent';
  const title = isAgent ? '改动文件' : '附件';
  const extras = editedCardExtras(files);
  return (
    <section className="edited-card" aria-label={`${title} ${files.length} 个`}>
      <header className="edited-card__head">
        {isAgent ? (
          <FilePenLine size={14} aria-hidden="true" />
        ) : (
          <Paperclip size={14} aria-hidden="true" />
        )}
        <h4 className="edited-card__title">
          {title} <span className="edited-card__count">{files.length}</span>
        </h4>
        {extras.length > 0 && <span className="edited-card__meta">{extras}</span>}
      </header>
      <ul className="edited-card__rows">
        {files.map((file) => (
          <EditedFileRow key={file.file_id} file={file} chatId={chatId} />
        ))}
      </ul>
    </section>
  );
}

function EditedFileRow({ file, chatId }: { file: ChatFile; chatId: string }) {
  const actions = useChatFileActions(chatId, file);
  const status = fileStatusOf(file);
  const historical = isHistoricalFile(file);
  const name = fileDisplayName(file);
  const segments = pathSegments(name);

  return (
    <li className="edited-card__row">
      <div className="edited-card__line">
        {/*
          The path is rendered as segments split after each separator so the
          line can wrap between directory names instead of cutting a word; the
          CSS `overflow-wrap: anywhere` is the fallback for one long segment.
          Nothing here sets `text-overflow` / `white-space: nowrap`.
        */}
        <span className="edited-card__path mono" title={name}>
          {segments.length > 1
            ? segments.map((segment, index) => (
                <span className="edited-card__segment" key={`${segment}-${index}`}>
                  {segment}
                </span>
              ))
            : name}
        </span>
        <span className="edited-card__summary">{fileSummaryOf(file)}</span>
        <span className={`edited-card__status is-${status.tone}`}>{status.label}</span>
        <span className="edited-card__actions">
          {actions.canPreviewText && actions.canAct && (
            <button
              type="button"
              className="edited-card__action"
              disabled={actions.previewLoading}
              aria-label={actions.expanded ? `收起 ${name} 预览` : `预览 ${name}`}
              onClick={() => void actions.toggleTextPreview()}
            >
              {actions.previewLoading ? '加载中…' : actions.expanded ? '收起' : '预览'}
            </button>
          )}
          {actions.canAct && (
            <button
              type="button"
              className="edited-card__action"
              disabled={actions.downloadLoading}
              aria-label={`下载 ${name}`}
              onClick={() => void actions.download()}
            >
              {actions.downloadLoading ? '下载中…' : '下载'}
            </button>
          )}
        </span>
      </div>
      {historical && (
        <p className="edited-card__note">
          历史附件：这条消息记录的是路径，引擎没有文件对象，预览与下载不可用。
        </p>
      )}
      {actions.error != null && (
        <p className="edited-card__error" role="alert">
          {actions.error}
        </p>
      )}
      {actions.expanded && actions.textPreview != null && (
        <pre className="edited-card__text">{actions.textPreview}</pre>
      )}
    </li>
  );
}