import { Paperclip } from 'lucide-react';

/**
 * Composer attachment button.
 *
 * Clicking asks the MAIN process to open the OS file dialog (`dialog.pick`),
 * because the renderer has no filesystem access. Drop and paste are handled by
 * <AttachmentDropZone> and land in the same upload chain.
 *
 * Muse: drop this into `.chat-composer__field` next to the send button and pass
 * `pick` from `useChatAttachments(chatId)`.
 */
export function AttachButton({
  onPick,
  disabled = false,
  busy = false,
  label = '添加附件',
  title = '添加附件（也可以把文件拖进聊天窗口，或粘贴图片）',
  className = '',
}: {
  onPick: () => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`attach-btn${busy ? ' is-busy' : ''}${className ? ` ${className}` : ''}`}
      aria-label={busy ? '附件上传中' : label}
      title={title}
      disabled={disabled}
      onClick={() => {
        void onPick();
      }}
    >
      <Paperclip size={16} aria-hidden="true" />
      {busy && <span className="attach-btn__spinner" aria-hidden="true" />}
    </button>
  );
}
