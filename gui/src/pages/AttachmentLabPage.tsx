import { Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../types';
import { AttachButton } from '../components/AttachButton';
import {
  AttachmentBar,
  AttachmentDropHint,
  AttachmentDropZone,
} from '../components/AttachmentBar';
import { FileCardList } from '../components/FileCard';
import {
  formatBytes,
  useChatAttachments,
  type ChatAttachmentsController,
} from '../lib/attachments';
import { listChatMessages, parseMentions, sendChatMessage } from '../lib/chat';
import '../styles/attachments.css';

/**
 * Attachment lab — a dev/verification-only page, reachable at
 * `#/__attachment-lab?chat=<chatId>` when `import.meta.env.DEV` is true or the
 * build set `VITE_ATTACHMENT_LAB=1`.
 *
 * It mounts the real attach button + drop zone + tray + file cards against the
 * real IPC bridge, so drag/paste/multi-select/progress/preview/delete can be
 * exercised before Muse wires the components into Composer. It also exposes
 * `window.__attachLab` so the headless Electron check
 * (`--attachment-verify`, see docs/upgrade-frontend-phase4.md) can drive real
 * DOM events and take screenshots.
 */

interface LabFileSpec {
  name: string;
  mime: string;
  text?: string;
  base64?: string;
}

interface LabPanelState {
  chatId: string;
  items: Array<{
    name: string;
    status: string;
    percent: number;
    kind: string;
    thumb: boolean;
  }>;
  cards: Array<{ name: string; thumb: boolean }>;
}

interface LabSendResult {
  ok: boolean;
  message: { message_id: string; files: string[]; mentions: string[] } | null;
  error?: string;
}

interface AttachLabApi {
  drop: (specs: LabFileSpec[]) => number;
  paste: (spec: LabFileSpec) => boolean;
  panelState: () => LabPanelState;
  thumbState: () => { loaded: number; broken: number };
  clickPreview: (name: string) => boolean;
  previewState: () => { open: boolean; highlighted: number; text: string };
  closePreview: () => boolean;
  clickRemove: (name: string) => boolean;
  send: (text: string) => Promise<LabSendResult>;
}

declare global {
  interface Window {
    __attachLab?: AttachLabApi;
  }
}

function labChatId(): string {
  const hash = window.location.hash;
  const queryIndex = hash.indexOf('?');
  if (queryIndex >= 0) {
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    const chatId = params.get('chat');
    if (chatId != null && /^[A-Za-z0-9_-]{1,128}$/.test(chatId)) {
      return chatId;
    }
  }
  return 'verify-chat-0001';
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function fileFromSpec(spec: LabFileSpec): File {
  const content =
    spec.base64 != null ? base64ToBytes(spec.base64) : new TextEncoder().encode(spec.text ?? '');
  return new File([content], spec.name, { type: spec.mime, lastModified: Date.now() });
}

function dropZone(): HTMLElement | null {
  return document.querySelector('[data-attach-dropzone]');
}

function cardFor(name: string): HTMLElement | null {
  const cards = Array.from(document.querySelectorAll<HTMLElement>('[data-file-name]'));
  return cards.find((card) => card.getAttribute('data-file-name') === name) ?? null;
}

export function AttachmentLabPage() {
  const chatId = labChatId();
  const controller = useChatAttachments(chatId);
  const [lastSent, setLastSent] = useState<ChatMessage | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const controllerRef = useRef<ChatAttachmentsController>(controller);
  controllerRef.current = controller;

  useEffect(() => {
    const api: AttachLabApi = {
      drop: (specs) => {
        const zone = dropZone();
        if (zone == null || specs.length === 0) {
          return 0;
        }
        const transfer = new DataTransfer();
        for (const spec of specs) {
          transfer.items.add(fileFromSpec(spec));
        }
        zone.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: transfer,
          }),
        );
        return specs.length;
      },
      paste: (spec) => {
        const zone = dropZone();
        if (zone == null) {
          return false;
        }
        const transfer = new DataTransfer();
        transfer.items.add(fileFromSpec(spec));
        const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: transfer });
        zone.dispatchEvent(event);
        return true;
      },
      panelState: () => ({
        chatId,
        items: controllerRef.current.items.map((item) => ({
          name: item.name,
          status: item.status,
          percent: item.percent,
          kind: item.kind,
          thumb: item.fileId != null && item.kind === 'image',
        })),
        cards: Array.from(document.querySelectorAll<HTMLElement>('[data-file-name]')).map(
          (card) => ({
            name: card.getAttribute('data-file-name') ?? '',
            thumb: card.querySelector('[data-file-thumb]') != null,
          }),
        ),
      }),
      thumbState: () => {
        const images = Array.from(
          document.querySelectorAll<HTMLImageElement>('[data-file-thumb]'),
        );
        return {
          loaded: images.filter((image) => image.complete && image.naturalWidth > 0).length,
          broken: images.filter((image) => image.complete && image.naturalWidth === 0).length,
        };
      },
      clickPreview: (name) => {
        const card = cardFor(name);
        const button = card?.querySelector<HTMLElement>('[data-action="preview"]');
        if (button == null) {
          return false;
        }
        button.click();
        return true;
      },
      previewState: () => {
        const overlay = document.querySelector('[data-preview-overlay]');
        const code = document.querySelector('[data-code-preview]');
        return {
          open: overlay != null,
          highlighted: document.querySelectorAll('[data-tok-type]').length,
          text: code?.textContent ?? '',
        };
      },
      closePreview: () => {
        const button = document.querySelector<HTMLElement>('.file-preview__close');
        if (button == null) {
          return false;
        }
        button.click();
        return true;
      },
      clickRemove: (name) => {
        const chips = Array.from(document.querySelectorAll<HTMLElement>('.attach-chip'));
        const chip = chips.find((item) => item.getAttribute('data-name') === name);
        const button = chip?.querySelector<HTMLElement>('.attach-chip__remove');
        if (button == null) {
          return false;
        }
        button.click();
        return true;
      },
      send: async (text) => {
        const current = controllerRef.current;
        const result = await sendChatMessage({
          chatId,
          summary: text,
          files: current.fileIds,
        });
        if (!result.ok) {
          return { ok: false, message: null, error: result.error };
        }
        const list = await listChatMessages({ chatId, limit: 200 });
        const messages = list.ok ? list.data.messages : [];
        const last = messages.length > 0 ? messages[messages.length - 1] : null;
        current.clear();
        return {
          ok: true,
          message:
            last != null
              ? {
                  message_id: last.message_id,
                  files: last.files.map((file) => file.file_id),
                  mentions: last.mentions,
                }
              : null,
        };
      },
    };
    window.__attachLab = api;
    return () => {
      delete window.__attachLab;
    };
  }, [chatId]);

  const send = async () => {
    if (controller.items.length === 0 || controller.busy) {
      return;
    }
    setSending(true);
    setSendError(null);
    const result = await window.__attachLab?.send('联调消息：附件 + @claude 提及');
    setSending(false);
    if (result == null) {
      return;
    }
    if (!result.ok) {
      setSendError(result.error ?? '发送失败。');
      return;
    }
    const list = await listChatMessages({ chatId, limit: 200 });
    if (list.ok && list.data.messages.length > 0) {
      setLastSent(list.data.messages[list.data.messages.length - 1]);
    }
  };

  const mentions = parseMentions('联调消息：附件 + @claude 提及');

  return (
    <div className="attach-lab" aria-label="附件功能验证页">
      <header className="attach-lab__head">
        <div>
          <h1 className="attach-lab__title">附件链路验证</h1>
          <p className="attach-lab__sub">
            群聊 <code>{chatId}</code> · 真实 IPC（选择器 / 拖拽 / 粘贴 / 分片上传 / 预览）
          </p>
        </div>
        <span className="attach-lab__badge">dev-only</span>
      </header>

      <div className="attach-lab__grid">
        <AttachmentDropZone
          className="attach-lab__composer"
          disabled={controller.busy}
          onFiles={(files, source) => void controller.intakeFiles(files, source)}
        >
          {controller.error != null && (
            <p className="attach-lab__error" role="alert">
              {controller.error}
            </p>
          )}
          <AttachmentBar
            chatId={chatId}
            items={controller.items}
            disabled={controller.busy}
            onRemove={(localId) => void controller.remove(localId)}
            onRetry={(localId) => void controller.retry(localId)}
          />
          <div className="attach-lab__row">
            <AttachButton
              onPick={controller.pick}
              busy={controller.busy}
              disabled={controller.busy}
            />
            <div className="attach-lab__fake-input">
              把文件拖进这个窗口，或粘贴图片；{formatBytes(controller.readyFiles.reduce((sum, file) => sum + file.size, 0))} 已就绪
            </div>
            <button
              type="button"
              className="attach-lab__send"
              disabled={sending || controller.busy || controller.items.length === 0}
              onClick={() => void send()}
            >
              <Send size={14} aria-hidden="true" />
              {sending ? '发送中…' : '发送'}
            </button>
          </div>
          <div className="attach-lab__hint-row">
            <AttachmentDropHint />
            {mentions.length > 0 && (
              <span className="attach-lab__mentions">
                将附带 @提及：{mentions.map((mention) => mention.id).join(', ')}
              </span>
            )}
          </div>
        </AttachmentDropZone>

        <section className="attach-lab__sent" aria-label="已上传附件">
          <h2 className="attach-lab__h2">待发送 / 已上传文件</h2>
          <FileCardList chatId={chatId} files={controller.readyFiles} />
          {controller.readyFiles.length === 0 && (
            <p className="attach-lab__empty">还没有文件。拖入、粘贴或点击回形针选择。</p>
          )}
          {sendError != null && (
            <p className="attach-lab__error" role="alert">
              {sendError}
            </p>
          )}
          {lastSent != null && (
            <p className="attach-lab__sent-note" data-last-sent="">
              已发送 {lastSent.message_id} · {lastSent.files.length} 个附件 · 提及{' '}
              {lastSent.mentions.length > 0 ? lastSent.mentions.join(', ') : '无'}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
