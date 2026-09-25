// HTTP layer: static PWA, JSON API for the phone app, and the remote MCP endpoint for Claude.

import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildForward, buildReply } from './compose.ts';
import { createMcpServer } from './mcp.ts';
import type { MailProvider, SendRequest } from './types.ts';

export interface AppOptions {
  token: string;
  readOnlyMcp?: boolean;
  publicDir?: string;
}

const PUBLIC_DIR = resolve(import.meta.dir, '..', 'public');

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h?.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `"${name}" is required`);
  return v;
}

function requireUid(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, '"uid" must be a positive integer');
  return n;
}

function stringList(v: unknown): string[] {
  if (v === undefined || v === null || v === '') return [];
  const arr = Array.isArray(v) ? v : String(v).split(/[,;]/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

function serveStatic(dir: string, pathname: string): Response | null {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = normalize(join(dir, rel));
  if (!file.startsWith(dir) || !existsSync(file)) return null;
  const ext = file.slice(file.lastIndexOf('.'));
  return new Response(readFileSync(file), {
    headers: {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  });
}

async function handleMcp(req: Request, provider: MailProvider, readOnly: boolean): Promise<Response> {
  // Stateless mode: a fresh server + transport per request keeps this horizontally simple.
  const server = createMcpServer(provider, { readOnly });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}

export function createFetchHandler(provider: MailProvider, opts: AppOptions) {
  const publicDir = opts.publicDir || PUBLIC_DIR;

  async function api(req: Request, url: URL): Promise<Response> {
    const q = url.searchParams;
    const route = `${req.method} ${url.pathname}`;
    const body = async () => {
      try {
        return (await req.json()) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, 'Invalid JSON body');
      }
    };

    switch (route) {
      case 'GET /api/account':
        return json({ account: provider.account, readOnlyMcp: !!opts.readOnlyMcp });

      case 'GET /api/folders':
        return json({ folders: await provider.listFolders() });

      case 'GET /api/messages':
        return json(
          await provider.listMessages({
            folder: q.get('folder') || 'INBOX',
            page: Number(q.get('page') || 1),
            pageSize: Number(q.get('pageSize') || 25),
            search: q.get('q') || undefined,
            unreadOnly: q.get('unread') === '1',
            flaggedOnly: q.get('flagged') === '1',
          }),
        );

      case 'GET /api/message': {
        const m = await provider.getMessage(requireString(q.get('folder'), 'folder'), requireUid(q.get('uid')));
        if (!m) throw new HttpError(404, 'Message not found');
        return json({ message: m });
      }

      case 'GET /api/attachment': {
        const a = await provider.getAttachment(
          requireString(q.get('folder'), 'folder'),
          requireUid(q.get('uid')),
          Number(q.get('index') || 0),
        );
        if (!a) throw new HttpError(404, 'Attachment not found');
        const inline = q.get('inline') === '1' && /^(image\/|application\/pdf|text\/plain)/.test(a.contentType);
        return new Response(Buffer.from(a.content), {
          headers: {
            'content-type': a.contentType,
            'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`,
            'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=300',
          },
        });
      }

      case 'PATCH /api/message': {
        const b = await body();
        await provider.setFlags(requireString(b.folder, 'folder'), requireUid(b.uid), {
          seen: typeof b.seen === 'boolean' ? b.seen : undefined,
          flagged: typeof b.flagged === 'boolean' ? b.flagged : undefined,
        });
        return json({ ok: true });
      }

      case 'POST /api/move': {
        const b = await body();
        await provider.move(requireString(b.folder, 'folder'), requireUid(b.uid), requireString(b.target, 'target'));
        return json({ ok: true });
      }

      case 'POST /api/delete': {
        const b = await body();
        await provider.remove(requireString(b.folder, 'folder'), requireUid(b.uid));
        return json({ ok: true });
      }

      case 'POST /api/send': {
        const b = await body();
        const to = stringList(b.to);
        if (!to.length) throw new HttpError(400, 'At least one recipient is required');
        const reqBody: SendRequest = {
          to,
          cc: stringList(b.cc),
          bcc: stringList(b.bcc),
          subject: typeof b.subject === 'string' ? b.subject : '',
          text: typeof b.text === 'string' ? b.text : '',
          html: typeof b.html === 'string' ? b.html : undefined,
          inReplyTo: typeof b.inReplyTo === 'string' ? b.inReplyTo : undefined,
          references: Array.isArray(b.references) ? b.references.map(String) : undefined,
          attachments: Array.isArray(b.attachments) ? (b.attachments as SendRequest['attachments']) : undefined,
        };
        return json(await provider.send(reqBody));
      }

      case 'POST /api/reply': {
        const b = await body();
        const folder = requireString(b.folder, 'folder');
        const uid = requireUid(b.uid);
        const m = await provider.getMessage(folder, uid);
        if (!m) throw new HttpError(404, 'Message not found');
        const reqBody = buildReply(m, typeof b.text === 'string' ? b.text : '', b.replyAll === true, provider.account);
        if (Array.isArray(b.attachments) && b.attachments.length) reqBody.attachments = b.attachments as SendRequest['attachments'];
        return json(await provider.send(reqBody));
      }

      case 'POST /api/forward': {
        const b = await body();
        const folder = requireString(b.folder, 'folder');
        const uid = requireUid(b.uid);
        const to = stringList(b.to);
        if (!to.length) throw new HttpError(400, 'At least one recipient is required');
        const m = await provider.getMessage(folder, uid);
        if (!m) throw new HttpError(404, 'Message not found');
        return json(await provider.send(await buildForward(provider, m, to, typeof b.text === 'string' ? b.text : '')));
      }
    }
    throw new HttpError(404, 'Not found');
  }

  return async function fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    try {
      if (path === '/health') return json({ ok: true });

      // Claude connects here. The token can be sent as a Bearer header (Claude Code / Desktop)
      // or embedded in the URL path (claude.ai custom connectors, which cannot set headers).
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const pathToken = path.startsWith('/mcp/') ? decodeURIComponent(path.slice(5)) : null;
        if (!tokenMatches(bearer(req) || pathToken, opts.token)) {
          await Bun.sleep(300);
          return json({ error: 'Unauthorized' }, 401);
        }
        return await handleMcp(req, provider, !!opts.readOnlyMcp);
      }

      if (path.startsWith('/api/')) {
        // Attachment links are opened by the browser directly, so they may carry the token in the query.
        const given = bearer(req) || (path === '/api/attachment' ? url.searchParams.get('token') : null);
        if (!tokenMatches(given, opts.token)) {
          await Bun.sleep(300);
          return json({ error: 'Unauthorized' }, 401);
        }
        return await api(req, url);
      }

      if (req.method === 'GET') {
        const res = serveStatic(publicDir, path);
        if (res) return res;
      }
      return json({ error: 'Not found' }, 404);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[http] ${req.method} ${path}:`, msg);
      return json({ error: msg }, 502);
    }
  };
}
