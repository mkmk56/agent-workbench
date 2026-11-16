import { protocol } from 'electron';
import {
  inlineContentType,
  type AttachmentEngine,
  type AttachmentService,
} from './attachments';

/**
 * Narrow custom protocol for attachment previews.
 *
 * Only raster images may be served inline; anything else is downgraded to a
 * generic download so a malicious upload can never execute as HTML/SVG in the
 * renderer origin. URLs carry `chat_id` + `file_id`, never a host path:
 *
 *   chat-attachment://file/<chatId>/<fileId>
 *
 * CSP keeps the scheme allow-listed for `img-src` only (see main.ts).
 */
export const CHAT_ATTACHMENT_SCHEME = 'chat-attachment';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_INLINE_BYTES = 32 * 1_024 * 1_024;

/** Must run before `app.whenReady()`; Electron requires early scheme privileges. */
export function registerChatAttachmentPrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: CHAT_ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function attachmentUrl(chatId: string, fileId: string): string {
  return `${CHAT_ATTACHMENT_SCHEME}://file/${encodeURIComponent(chatId)}/${encodeURIComponent(fileId)}`;
}

export interface ChatAttachmentProtocolDeps {
  service: AttachmentService;
  engine: AttachmentEngine;
}

export function installChatAttachmentProtocol(deps: ChatAttachmentProtocolDeps): void {
  protocol.handle(CHAT_ATTACHMENT_SCHEME, async (request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    if (parsed.hostname !== 'file') {
      return new Response('not found', { status: 404 });
    }
    const segments = parsed.pathname.split('/').filter((item) => item.length > 0);
    if (segments.length !== 2) {
      return new Response('not found', { status: 404 });
    }
    const [chatId, fileId] = segments.map((item) => decodeURIComponent(item));
    if (!ID_PATTERN.test(chatId) || !ID_PATTERN.test(fileId)) {
      return new Response('bad request', { status: 400 });
    }

    try {
      const result = await deps.service.fetchBytes({
        chatId,
        fileId,
        engine: deps.engine,
        maxBytes: MAX_INLINE_BYTES,
      });
      const contentType = inlineContentType(result.name, result.mime);
      if (contentType == null) {
        return new Response(new Uint8Array(result.bytes), {
          status: 200,
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': 'attachment',
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      }
      return new Response(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': 'inline',
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    } catch {
      return new Response('file unavailable', { status: 404 });
    }
  });
}
