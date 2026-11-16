import { app, net, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  formatBytes,
  type AttachmentDraft,
  type AttachmentService,
  type ChatFilePayload,
} from './attachments';
import { attachmentUrl } from './chat-protocol';
import { errorMessage, type EngineManager } from './engine';

/**
 * Headless end-to-end check of the attachment pipeline.
 *
 * Mirrors the existing `--update-verify` seam: enabled with `--attachment-verify`
 * and a few env vars, writes machine-readable evidence, then exits. It runs the
 * REAL main-process services (AttachmentService + EngineManager) against a stub
 * MCP engine, so chunking, hashing, size accounting, protocol serving and the
 * chat message contract are exercised without touching the production engine.
 *
 * Env:
 *   WORKBENCH_ATTACH_VERIFY_DIR   output directory (required)
 *   WORKBENCH_ATTACH_VERIFY_CHAT  chat id to use (default verify-chat-0001)
 *   WORKBENCH_ATTACH_VERIFY_FILES JSON array of absolute paths to upload
 *   WORKBENCH_ATTACH_VERIFY_UI    "1" → drive the renderer lab page + screenshots
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface VerifyDeps {
  window: BrowserWindow | null;
  engine: EngineManager;
  attachments: AttachmentService;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(
  probe: () => Promise<T | null | false>,
  timeoutMs: number,
  intervalMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) {
        return value;
      }
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `等待超时（${timeoutMs}ms）${last instanceof Error ? `：${last.message}` : ''}`,
  );
}

export async function runAttachmentVerification(deps: VerifyDeps): Promise<void> {
  const outDir = process.env.WORKBENCH_ATTACH_VERIFY_DIR?.trim();
  const chatId = process.env.WORKBENCH_ATTACH_VERIFY_CHAT?.trim() || 'verify-chat-0001';
  const rawFiles = process.env.WORKBENCH_ATTACH_VERIFY_FILES?.trim() || '[]';
  const runUi = process.env.WORKBENCH_ATTACH_VERIFY_UI === '1';

  const checks: Check[] = [];
  const screenshots: string[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
  };

  if (outDir == null || outDir.length === 0) {
    console.error('WORKBENCH_ATTACH_VERIFY_DIR is required');
    app.exit(2);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  try {
    const filePaths = JSON.parse(rawFiles) as unknown;
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('WORKBENCH_ATTACH_VERIFY_FILES must be a non-empty JSON array');
    }

    // 1) Draft registration (same code path as dialog / drop intake).
    let drafts: AttachmentDraft[] = [];
    try {
      drafts = await deps.attachments.registerPaths(filePaths, 'dialog');
      record(
        'draft-register',
        drafts.length === filePaths.length,
        `registered ${drafts.length}/${filePaths.length}: ${drafts
          .map((draft) => `${draft.name} (${formatBytes(draft.size)}, ${draft.kind})`)
          .join(', ')}`,
      );
    } catch (error) {
      record('draft-register', false, errorMessage(error));
      throw error;
    }

    // 2) Chunked upload (1 MB chunks; init → chunk×N → complete).
    const uploadId = `verify-${Date.now()}`;
    const progress: Array<{ name: string; percent: number; phase: string }> = [];
    const started = Date.now();
    const uploaded = await deps.attachments.upload({
      chatId,
      draftIds: drafts.map((draft) => draft.draftId),
      uploadId,
      engine: deps.engine,
      onProgress: (item) => {
        progress.push({ name: item.name, percent: item.percent, phase: item.phase });
      },
    });
    const elapsed = Date.now() - started;
    record(
      'chunked-upload',
      uploaded.files.length === drafts.length && uploaded.errors.length === 0,
      `${uploaded.files.length}/${drafts.length} files in ${elapsed}ms, ` +
        `${progress.filter((item) => item.phase === 'chunk').length} chunk events, ` +
        `errors: ${JSON.stringify(uploaded.errors)}`,
    );
    const bigFile = uploaded.files.find((file) => file.size > 1_048_576);
    record(
      'multi-chunk',
      bigFile != null &&
        progress.some(
          (item) => item.phase === 'chunk' && item.name === bigFile.name && item.percent < 100,
        ),
      bigFile != null
        ? `${bigFile.name} (${formatBytes(bigFile.size)}) used >1 chunk with intermediate progress`
        : 'no file >1MB in the sample set (skipped)',
    );

    const byName = new Map<string, ChatFilePayload>();
    for (const file of uploaded.files) {
      byName.set(file.name, file);
    }

    // 3) Read back bytes by file_id and compare against the local original.
    for (const draft of drafts) {
      const file = byName.get(draft.name);
      if (file == null) {
        record(`read-back:${draft.name}`, false, 'file missing from upload result');
        continue;
      }
      if (file.kind === 'image') {
        const fetched = await deps.attachments.fetchBytes({
          chatId,
          fileId: file.file_id,
          engine: deps.engine,
        });
        const originalPath = filePaths.find(
          (candidate) => path.basename(String(candidate)) === draft.name,
        );
        const original = originalPath != null ? fs.readFileSync(String(originalPath)) : null;
        const same =
          original != null &&
          original.length === fetched.bytes.length &&
          original.equals(fetched.bytes);
        record(
          `read-back-bytes:${draft.name}`,
          same,
          same
            ? `${formatBytes(fetched.bytes.length)} identical to source`
            : `byte mismatch (source ${original?.length ?? 'missing'} vs fetched ${fetched.bytes.length})`,
        );
        continue;
      }
      const raw = await deps.engine.readChatFile({
        chatId,
        fileId: file.file_id,
        maxBytes: 64 * 1_024,
      });
      const row = (raw ?? {}) as Record<string, unknown>;
      const content =
        typeof row.text === 'string'
          ? row.text
          : typeof row.content === 'string'
            ? row.content
            : '';
      record(
        `read-text:${draft.name}`,
        content.length > 0,
        `${content.length} chars of text returned for kind=${file.kind}`,
      );
    }

    // 4) Message contract: files + mentions + replyTo + clientMsgId.
    const clientMsgId = `verify-client-${Date.now()}`;
    const sent = await deps.engine.sendChatMessage({
      chatId,
      from: 'user',
      to: 'muse',
      summary: '附件联调：请查看这些文件并说明解析结果。@claude @dsh',
      files: uploaded.files.map((file) => file.file_id),
      mentions: ['claude', 'dsh'],
      replyTo: undefined,
      clientMsgId,
    });
    const sentRecord = (sent ?? {}) as Record<string, unknown>;
    const messageId =
      typeof sentRecord.message_id === 'string' ? sentRecord.message_id : null;
    record(
      'send-contract',
      messageId != null && sentRecord.client_msg_id === clientMsgId,
      `message_id=${String(messageId)}, client_msg_id echoed=${String(sentRecord.client_msg_id)}, ` +
        `files=${uploaded.files.length}, mentions=${JSON.stringify(sentRecord.mentions)}`,
    );

    // 5) Reply-to on a follow-up message.
    if (messageId != null) {
      const reply = await deps.engine.sendChatMessage({
        chatId,
        from: 'user',
        to: 'muse',
        summary: '补充说明：优先看 PDF 和表格。',
        replyTo: messageId,
        clientMsgId: `${clientMsgId}-reply`,
      });
      const replyRecord = (reply ?? {}) as Record<string, unknown>;
      record(
        'reply-to',
        typeof replyRecord.reply_to === 'string' && replyRecord.reply_to === messageId,
        `reply_to=${String(replyRecord.reply_to)}`,
      );
    }

    // 6) Incremental sequence cursor.
    const all = await deps.engine.listChatMessages({ chatId, limit: 200 });
    const allMessages = Array.isArray(all.messages) ? all.messages : [];
    const lastSeq = allMessages.reduce((max, message) => {
      const seq = (message as Record<string, unknown>).seq;
      return typeof seq === 'number' && seq > max ? seq : max;
    }, 0);
    const incremental = await deps.engine.listChatMessages({
      chatId,
      limit: 200,
      afterSeq: Math.max(0, lastSeq - 1),
    });
    const incrementalMessages = Array.isArray(incremental.messages) ? incremental.messages : [];
    record(
      'seq-cursor',
      lastSeq > 0 &&
        incrementalMessages.length > 0 &&
        incrementalMessages.every(
          (message) => Number((message as Record<string, unknown>).seq) > lastSeq - 1,
        ),
      `total=${allMessages.length}, last_seq=${lastSeq}, after_seq=${Math.max(0, lastSeq - 1)} → ` +
        `${incrementalMessages.length} message(s)`,
    );

    // 7) Participants + mark-read.
    const participantsRaw = await deps.engine.chatParticipants(chatId);
    const participants = Array.isArray((participantsRaw as Record<string, unknown>).participants)
      ? ((participantsRaw as Record<string, unknown>).participants as unknown[])
      : [];
    record(
      'participants',
      participants.length === 4,
      `${participants.length} participants: ${participants
        .map((item) => String((item as Record<string, unknown>).id))
        .join(', ')}`,
    );

    const marked = await deps.engine.chatMarkRead({ chatId, upToSeq: lastSeq });
    const markedRecord = (marked ?? {}) as Record<string, unknown>;
    record(
      'mark-read',
      typeof markedRecord.last_read_seq === 'number' &&
        markedRecord.last_read_seq >= lastSeq &&
        Number(markedRecord.unread ?? 0) === 0,
      `last_read_seq=${String(markedRecord.last_read_seq)}, unread=${String(markedRecord.unread)}`,
    );

    // 8) Custom protocol serves images inline and refuses text inline.
    const imageFile = uploaded.files.find((file) => file.kind === 'image');
    if (imageFile != null) {
      const url = attachmentUrl(chatId, imageFile.file_id);
      const response = await net.fetch(url);
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? '';
      record(
        'protocol-image',
        response.status === 200 &&
          contentType.startsWith('image/') &&
          body.length === imageFile.size,
        `${url} → ${response.status} ${contentType} ${body.length}B`,
      );
      const textFile = uploaded.files.find(
        (file) => file.kind === 'text' || file.kind === 'code' || file.kind === 'zip',
      );
      if (textFile != null) {
        const textResponse = await net.fetch(attachmentUrl(chatId, textFile.file_id));
        const textType = textResponse.headers.get('content-type') ?? '';
        record(
          'protocol-no-inline-text',
          !textType.startsWith('text/') && !textType.includes('html'),
          `${textFile.name} served as ${textType} (never inline text/html)`,
        );
      }
    } else {
      record('protocol-image', false, 'no image in the sample set');
    }

    // 9) Validation guards: oversized / too many / unknown draft.
    try {
      await deps.attachments.upload({
        chatId,
        draftIds: ['does-not-exist'],
        uploadId: 'verify-invalid',
        engine: deps.engine,
      });
      record('guard-unknown-draft', false, 'unknown draft id was accepted');
    } catch (error) {
      record('guard-unknown-draft', true, errorMessage(error));
    }
    try {
      await deps.attachments.registerPaths([], 'dialog');
      record('guard-empty-pick', false, 'empty selection was accepted');
    } catch (error) {
      record('guard-empty-pick', true, errorMessage(error));
    }

    // 10) Renderer lab: drag / multi / paste / preview / delete / progress.
    if (runUi && deps.window != null) {
      const ui = await driveRenderer(deps.window, chatId, outDir);
      for (const item of ui.checks) {
        checks.push(item);
      }
      screenshots.push(...ui.screenshots);
    } else {
      record('renderer-lab', false, 'skipped (WORKBENCH_ATTACH_VERIFY_UI != 1)');
    }

    const ok = checks.every((check) => check.ok);
    const result = {
      ok,
      at: new Date().toISOString(),
      chatId,
      checks,
      screenshots,
      drafts: drafts.map((draft) => ({
        name: draft.name,
        size: draft.size,
        kind: draft.kind,
        mime: draft.mime,
      })),
      files: uploaded.files,
      elapsedMs: elapsed,
    };
    fs.writeFileSync(
      path.join(outDir, 'attachment-verify.json'),
      `${JSON.stringify(result, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok, checks: checks.length, outDir }));
    app.exit(ok ? 0 : 1);
  } catch (error) {
    const result = {
      ok: false,
      at: new Date().toISOString(),
      chatId,
      checks,
      screenshots,
      fatal: errorMessage(error),
    };
    try {
      fs.writeFileSync(
        path.join(outDir, 'attachment-verify.json'),
        `${JSON.stringify(result, null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Best effort.
    }
    console.error(errorMessage(error));
    app.exit(1);
  }
}

interface LabFileSpec {
  name: string;
  mime: string;
  text?: string;
  base64?: string;
}

async function driveRenderer(
  win: BrowserWindow,
  chatId: string,
  outDir: string,
): Promise<{ checks: Check[]; screenshots: string[] }> {
  const checks: Check[] = [];
  const screenshots: string[] = [];

  const shoot = async (name: string) => {
    const image = await win.webContents.capturePage();
    const target = path.join(outDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG());
    screenshots.push(target);
  };

  const evaluate = <T>(code: string): Promise<T> =>
    win.webContents.executeJavaScript(code, true) as Promise<T>;

  const base = win.webContents.getURL().split('#')[0];
  await win.webContents.loadURL(
    `${base}#/__attachment-lab?chat=${encodeURIComponent(chatId)}`,
  );
  await waitFor(async () => evaluate<boolean>('Boolean(window.__attachLab)'), 20_000);
  await sleep(400);

  // Prepare a drop with three files (multi-select semantics), a paste image and
  // a code file, all synthesized inside the renderer as real File objects.
  const sampleText = [
    'export function sum(values: number[]): number {',
    '  // 1 MB chunked upload keeps large files off the IPC heap',
    '  return values.reduce((total, value) => total + value, 0);',
    '}',
  ].join('\n');
  const dropSpec: LabFileSpec[] = [
    { name: 'drag-multi-a.txt', mime: 'text/plain', text: '第一份拖拽文件（多选之一）' },
    { name: 'drag-multi-b.md', mime: 'text/markdown', text: '# 拖拽文件二\n- 多选\n- 同一上传链路' },
    { name: 'drag-code.ts', mime: 'text/typescript', text: sampleText },
  ];
  await evaluate(`window.__attachLab.drop(${JSON.stringify(dropSpec)})`);
  await sleep(250);
  await shoot('01-drop-multi-uploading');
  const activeDuringUpload = await evaluate<number>(
    'window.__attachLab.panelState().items.filter((i) => i.status === "uploading").length',
  );
  await waitFor(
    async () =>
      (await evaluate<number>(
        'window.__attachLab.panelState().items.filter((i) => i.status === "uploading").length',
      )) === 0,
    30_000,
  );
  await sleep(250);
  await shoot('02-drop-multi-ready');
  const stateAfterDrop = await evaluate<{
    items: Array<{ name: string; status: string; percent: number }>;
    cards: Array<{ name: string; thumb: boolean }>;
  }>('window.__attachLab.panelState()');
  checks.push({
    name: 'ui-multi-drop',
    ok: stateAfterDrop.items.length === dropSpec.length &&
      stateAfterDrop.items.every((item) => item.status === 'ready'),
    detail: `${stateAfterDrop.items.length} items settled (uploading during drop: ${activeDuringUpload}): ${stateAfterDrop.items
      .map((item) => `${item.name}:${item.status}@${item.percent}%`)
      .join(', ')}`,
  });

  // Paste an image (clipboard-style, no path) and confirm it joins the chain.
  const pngBase64 = makePngBase64();
  await evaluate(
    `window.__attachLab.paste(${JSON.stringify({ name: 'pasted-shot.png', mime: 'image/png', base64: pngBase64 })})`,
  );
  await waitFor(
    async () =>
      (await evaluate<number>(
        'window.__attachLab.panelState().items.filter((i) => i.status === "uploading").length',
      )) === 0,
    30_000,
  );
  await sleep(300);
  await shoot('03-paste-image-ready');
  const stateAfterPaste = await evaluate<{
    items: Array<{ name: string; status: string; thumb: boolean }>;
  }>('window.__attachLab.panelState()');
  const pasted = stateAfterPaste.items.find((item) => item.name === 'pasted-shot.png');
  checks.push({
    name: 'ui-paste-image',
    ok: pasted != null && pasted.status === 'ready' && pasted.thumb,
    detail: `pasted item=${JSON.stringify(pasted ?? null)}`,
  });

  // Preview: code file with syntax highlighting.
  const previewOk = await evaluate<boolean>(
    'window.__attachLab.clickPreview("drag-code.ts")',
  );
  await sleep(400);
  await shoot('04-code-preview');
  const previewState = await evaluate<{ open: boolean; highlighted: number; text: string }>(
    'window.__attachLab.previewState()',
  );
  checks.push({
    name: 'ui-code-preview',
    ok: previewOk && previewState.open && previewState.highlighted > 0,
    detail: `overlay open=${previewState.open}, highlighted tokens=${previewState.highlighted}, ${previewState.text.length} chars`,
  });
  await evaluate('window.__attachLab.closePreview()');
  await sleep(200);

  // Image thumbnail actually rendered through the custom protocol.
  const thumbInfo = await evaluate<{ loaded: number; broken: number }>(
    'window.__attachLab.thumbState()',
  );
  checks.push({
    name: 'ui-image-thumbnail',
    ok: thumbInfo.loaded > 0 && thumbInfo.broken === 0,
    detail: `thumbnails loaded=${thumbInfo.loaded}, broken=${thumbInfo.broken}`,
  });

  // Delete one pending item.
  const removeOk = await evaluate<boolean>('window.__attachLab.clickRemove("drag-multi-b.md")');
  await sleep(250);
  const afterRemove = await evaluate<{ items: Array<{ name: string }> }>(
    'window.__attachLab.panelState()',
  );
  checks.push({
    name: 'ui-delete-attachment',
    ok: removeOk && !afterRemove.items.some((item) => item.name === 'drag-multi-b.md'),
    detail: `remaining: ${afterRemove.items.map((item) => item.name).join(', ')}`,
  });

  // "Send" with the remaining file ids and confirm the message carries them.
  const sent = await evaluate<{
    ok: boolean;
    message: { message_id?: string; files?: unknown[]; mentions?: unknown[] } | null;
    error?: string;
  }>(
    `window.__attachLab.send('联调消息：附件 + @claude 提及')`,
  );
  checks.push({
    name: 'ui-send-with-files',
    ok: sent.ok && Array.isArray(sent.message?.files) && (sent.message?.files.length ?? 0) > 0,
    detail: sent.ok
      ? `message_id=${String(sent.message?.message_id)}, files=${JSON.stringify(sent.message?.files)}`
      : `error=${sent.error ?? 'unknown'}`,
  });

  return { checks, screenshots };
}

/** 1×1 PNG — enough to prove the image path works end to end. */
function makePngBase64(): string {
  return 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
}
