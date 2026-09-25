// MCP server: exposes the mailbox to Claude (Claude Desktop, Claude Code, claude.ai connectors).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildForward, buildReply, formatAddress } from './compose.ts';
import type { MailProvider, Message, MessageSummary } from './types.ts';

export interface McpOptions {
  /** Hide tools that send, move, or delete mail. */
  readOnly?: boolean;
}

const MAX_BODY_CHARS = 40_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function fail(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true };
}

function summaryLine(m: MessageSummary): string {
  const flags = [m.seen ? '' : 'UNREAD', m.flagged ? 'FLAGGED' : '', m.hasAttachments ? 'ATTACHMENT' : ''].filter(Boolean);
  return [
    `uid=${m.uid} | ${m.date} | from: ${formatAddress(m.from)}${flags.length ? ` | ${flags.join(',')}` : ''}`,
    `  subject: ${m.subject}`,
    m.preview ? `  preview: ${m.preview}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function fullMessage(m: Message): string {
  let body = m.text || '(empty body)';
  if (body.length > MAX_BODY_CHARS) body = `${body.slice(0, MAX_BODY_CHARS)}\n... [truncated, ${m.text.length} chars total]`;
  const lines = [
    `Folder: ${m.folder}  UID: ${m.uid}`,
    `Message-ID: ${m.messageId || '-'}`,
    `Date: ${m.date}`,
    `From: ${formatAddress(m.from)}`,
    `To: ${m.to.map(formatAddress).join(', ')}`,
  ];
  if (m.cc.length) lines.push(`Cc: ${m.cc.map(formatAddress).join(', ')}`);
  lines.push(`Subject: ${m.subject}`);
  if (m.attachments.length) {
    lines.push(`Attachments: ${m.attachments.map((a) => `[${a.index}] ${a.filename} (${a.contentType}, ${a.size} bytes)`).join('; ')}`);
  }
  lines.push('', body);
  return lines.join('\n');
}

const folderArg = z.string().default('INBOX').describe('Folder path as returned by list_folders, e.g. "INBOX"');
const uidArg = z.number().int().positive().describe('Message UID from list_emails / search_emails');
const addressesArg = z.array(z.string()).describe('Email addresses, e.g. ["Jan <jan@example.com>", "ola@example.com"]');

export function createMcpServer(provider: MailProvider, opts: McpOptions = {}): McpServer {
  const server = new McpServer(
    { name: 'pocket-mail', version: '0.1.0' },
    {
      instructions:
        `Mailbox of ${formatAddress(provider.account)}. Use list_emails / search_emails to find messages, ` +
        'read_email to open one (folder + uid), and send_email / reply_to_email / forward_email to write. ' +
        'Always show the user the recipients, subject and body and get confirmation before sending.',
    },
  );

  server.registerTool(
    'get_account',
    { title: 'Get account', description: 'Show which email address this mailbox belongs to.', annotations: { readOnlyHint: true } },
    async () => text(`Account: ${formatAddress(provider.account)}\nRead-only mode: ${opts.readOnly ? 'yes' : 'no'}`),
  );

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description: 'List mail folders with unread and total counts.',
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const folders = await provider.listFolders();
        return text(
          folders
            .map((f) => `${f.path}${f.role ? ` [${f.role}]` : ''} — unread: ${f.unread ?? '?'}, total: ${f.total ?? '?'}`)
            .join('\n'),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_emails',
    {
      title: 'List emails',
      description: 'List emails in a folder, newest first.',
      inputSchema: {
        folder: folderArg,
        page: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(100).default(20),
        unread_only: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, page, page_size, unread_only }) => {
      try {
        const r = await provider.listMessages({ folder, page, pageSize: page_size, unreadOnly: unread_only });
        const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
        return text(
          `${r.folder}: ${r.total} message(s), page ${r.page}/${pages}\n\n` +
            (r.messages.map(summaryLine).join('\n\n') || '(no messages)'),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'search_emails',
    {
      title: 'Search emails',
      description: 'Search a folder by text in subject, sender, recipients or body.',
      inputSchema: {
        query: z.string().min(1),
        folder: folderArg,
        page: z.number().int().positive().default(1),
        page_size: z.number().int().min(1).max(100).default(20),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, folder, page, page_size }) => {
      try {
        const r = await provider.listMessages({ folder, search: query, page, pageSize: page_size });
        return text(
          `Search "${query}" in ${r.folder}: ${r.total} match(es)\n\n` + (r.messages.map(summaryLine).join('\n\n') || '(no matches)'),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'read_email',
    {
      title: 'Read email',
      description: 'Open a message and return its headers, body text and attachment list.',
      inputSchema: {
        folder: folderArg,
        uid: uidArg,
        mark_as_read: z.boolean().default(false).describe('Also mark the message as read'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, uid, mark_as_read }) => {
      try {
        const m = await provider.getMessage(folder, uid);
        if (!m) return fail(`No message ${uid} in ${folder}`);
        if (mark_as_read && !m.seen && !opts.readOnly) await provider.setFlags(folder, uid, { seen: true });
        return text(fullMessage(m));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'get_attachment',
    {
      title: 'Get attachment',
      description: 'Download one attachment. Text files come back as text, images as images, anything else as base64.',
      inputSchema: { folder: folderArg, uid: uidArg, index: z.number().int().min(0).describe('Attachment index from read_email') },
      annotations: { readOnlyHint: true },
    },
    async ({ folder, uid, index }) => {
      try {
        const a = await provider.getAttachment(folder, uid, index);
        if (!a) return fail(`No attachment ${index} on message ${uid}`);
        if (a.content.length > MAX_ATTACHMENT_BYTES) return fail(`${a.filename} is ${a.content.length} bytes, larger than the 5 MB limit`);
        const b64 = Buffer.from(a.content).toString('base64');
        if (a.contentType.startsWith('text/') || /json|xml|csv/.test(a.contentType)) {
          return text(`${a.filename} (${a.contentType}):\n\n${new TextDecoder().decode(a.content)}`);
        }
        if (a.contentType.startsWith('image/')) {
          return { content: [{ type: 'image' as const, data: b64, mimeType: a.contentType }] };
        }
        return {
          content: [
            {
              type: 'resource' as const,
              resource: { uri: `mail://${encodeURIComponent(folder)}/${uid}/${index}/${encodeURIComponent(a.filename)}`, mimeType: a.contentType, blob: b64 },
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  if (opts.readOnly) return server;

  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description: 'Send a new email. Confirm recipients, subject and body with the user first.',
      inputSchema: {
        to: addressesArg.min(1),
        cc: addressesArg.optional(),
        bcc: addressesArg.optional(),
        subject: z.string(),
        body: z.string().describe('Plain-text body'),
        html: z.string().optional().describe('Optional HTML version of the body'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ to, cc, bcc, subject, body, html }) => {
      try {
        const r = await provider.send({ to, cc, bcc, subject, text: body, html });
        return text(`Sent. Message-ID: ${r.messageId}\nAccepted: ${r.accepted.join(', ') || '-'}\nRejected: ${r.rejected.join(', ') || '-'}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'reply_to_email',
    {
      title: 'Reply to email',
      description: 'Reply to a message (keeps the thread and quotes the original). Confirm the text with the user first.',
      inputSchema: {
        folder: folderArg,
        uid: uidArg,
        body: z.string().describe('Your reply text; the original is quoted below it automatically'),
        reply_all: z.boolean().default(false),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, body, reply_all }) => {
      try {
        const m = await provider.getMessage(folder, uid);
        if (!m) return fail(`No message ${uid} in ${folder}`);
        const req = buildReply(m, body, reply_all, provider.account);
        const r = await provider.send(req);
        await provider.setFlags(folder, uid, { seen: true }).catch(() => {});
        return text(`Reply sent to ${[...req.to, ...(req.cc || [])].join(', ')}. Message-ID: ${r.messageId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'forward_email',
    {
      title: 'Forward email',
      description: 'Forward a message (with its attachments) to new recipients.',
      inputSchema: { folder: folderArg, uid: uidArg, to: addressesArg.min(1), note: z.string().default('') },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ folder, uid, to, note }) => {
      try {
        const m = await provider.getMessage(folder, uid);
        if (!m) return fail(`No message ${uid} in ${folder}`);
        const r = await provider.send(await buildForward(provider, m, to, note));
        return text(`Forwarded to ${to.join(', ')}. Message-ID: ${r.messageId}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'mark_email',
    {
      title: 'Mark email',
      description: 'Mark a message read/unread and/or flagged/unflagged.',
      inputSchema: { folder: folderArg, uid: uidArg, read: z.boolean().optional(), flagged: z.boolean().optional() },
      annotations: { idempotentHint: true },
    },
    async ({ folder, uid, read, flagged }) => {
      try {
        await provider.setFlags(folder, uid, { seen: read, flagged });
        return text('Done.');
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'move_email',
    {
      title: 'Move email',
      description: 'Move a message to another folder (e.g. Archive).',
      inputSchema: { folder: folderArg, uid: uidArg, target_folder: z.string() },
    },
    async ({ folder, uid, target_folder }) => {
      try {
        await provider.move(folder, uid, target_folder);
        return text(`Moved to ${target_folder}.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'delete_email',
    {
      title: 'Delete email',
      description: 'Move a message to Trash (or delete permanently if it is already in Trash).',
      inputSchema: { folder: folderArg, uid: uidArg },
      annotations: { destructiveHint: true },
    },
    async ({ folder, uid }) => {
      try {
        await provider.remove(folder, uid);
        return text('Deleted.');
      } catch (err) {
        return fail(err);
      }
    },
  );

  return server;
}
