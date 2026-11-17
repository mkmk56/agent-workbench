import { useEffect, useState } from 'react';
import type { ChatFile } from '../lib/chat';
import { downloadChatFile, previewChatFile, readChatFile } from '../lib/chat';
import { fileKindOf, isHistoricalFile } from '../lib/chat-files';

/**
 * Preview / download behaviour shared by the flat file card (Files page) and
 * the "Edited files" card (chat stream), so both surfaces behave identically.
 *
 * Real behaviour only: an image preview comes from `preview_chat_file`, a text
 * preview from `read_chat_file`; any failure is surfaced as text, never as a
 * fake preview. Historical attachments (legacy path rows) cannot be previewed or
 * downloaded — the engine has no bytes for them (docs/REFACTOR_PLAN.md §3.1).
 */
export type ChatFileActions = {
  previewUrl: string | null;
  textPreview: string | null;
  expanded: boolean;
  previewLoading: boolean;
  downloadLoading: boolean;
  error: string | null;
  canPreviewText: boolean;
  canAct: boolean;
  toggleTextPreview: () => Promise<void>;
  download: () => Promise<void>;
};

export function useChatFileActions(chatId: string, file: ChatFile): ChatFileActions {
  const kind = fileKindOf(file);
  const canAct = !isHistoricalFile(file);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [textPreview, setTextPreview] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloadLoading, setDownloadLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (!canAct || kind !== 'image') {
      return () => {
        alive = false;
      };
    }
    void previewChatFile(chatId, file.file_id).then((result) => {
      if (!alive) {
        return;
      }
      if (result.ok) {
        setPreviewUrl(result.data.url);
      }
      // A missing thumbnail is not an error state the reader must handle: the
      // icon fallback stays, and an explicit action still reports failures.
    });
    return () => {
      alive = false;
    };
  }, [chatId, file.file_id, kind, canAct]);

  const toggleTextPreview = async () => {
    if (!canAct) {
      return;
    }
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (textPreview != null) {
      setExpanded(true);
      return;
    }
    setPreviewLoading(true);
    setError(null);
    const result = await readChatFile(chatId, file.file_id);
    setPreviewLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setTextPreview(result.data.text);
    setExpanded(true);
  };

  const download = async () => {
    if (!canAct) {
      return;
    }
    setDownloadLoading(true);
    setError(null);
    const result = await downloadChatFile(chatId, file.file_id);
    setDownloadLoading(false);
    if (!result.ok) {
      setError(result.error);
    }
  };

  return {
    previewUrl,
    textPreview,
    expanded,
    previewLoading,
    downloadLoading,
    error,
    canPreviewText:
      kind === 'docx' || kind === 'code' || kind === 'text' || kind === 'xlsx' || kind === 'pdf',
    canAct,
    toggleTextPreview,
    download,
  };
}