import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createFetchHandler } from '../server/app.ts';
import { buildReply } from '../server/compose.ts';
import { loadConfig } from '../server/config.ts';
import { DemoProvider } from '../server/demo-provider.ts';

const TOKEN = 'test-token-0123456789abcdef';

function startServer(opts: { readOnlyMcp?: boolean } = {}) {
  const provider = new DemoProvider();
  const server = Bun.serve({ port: 0, fetch: createFetchHandler(provider, { token: TOKEN, ...opts }) });
  return { provider, server, base: `http://localhost:${server.port}` };
}

async function mcpClient(url: string, headers: Record<string, string> = {}) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}

function toolText(res: unknown): string {
  const content = (res as { content: { type: string; text?: string }[] }).content;
  return content.map((c) => c.text || '').join('\n');
}

describe('config', () => {
  test('fills IMAP/SMTP hosts from the address domain', () => {
    const cfg = loadConfig({ MAIL_USER: 'me@gmail.com', MAIL_PASSWORD: 'x', MAIL_APP_TOKEN: 'a'.repeat(24) });
    expect(cfg.imap?.host).toBe('imap.gmail.com');
    expect(cfg.smtp).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true });
  });

  test('Outlook uses STARTTLS on 587', () => {
    const cfg = loadConfig({ MAIL_USER: 'me@outlook.com', MAIL_PASSWORD: 'x', MAIL_APP_TOKEN: 'a'.repeat(24) });
    expect(cfg.smtp).toMatchObject({ host: 'smtp.office365.com', port: 587, secure: false });
  });

  test('rejects missing settings and short tokens', () => {
    expect(() => loadConfig({})).toThrow(/MAIL_USER/);
    expect(() => loadConfig({ MAIL_USER: 'a@gmail.com', MAIL_PASSWORD: 'x', MAIL_APP_TOKEN: 'short' })).toThrow(/16/);
    expect(() => loadConfig({ MAIL_USER: 'a@unknown.example', MAIL_PASSWORD: 'x', MAIL_APP_TOKEN: 'a'.repeat(24) })).toThrow(/IMAP_HOST/);
  });
});

describe('compose', () => {
  test('reply-all excludes self and threads the conversation', async () => {
    const p = new DemoProvider();
    const msg = (await p.getMessage('INBOX', 1))!;
    msg.cc = [{ address: 'me@example.com' }, { name: 'Ivan', address: 'ivan@example.com' }];
    msg.references = ['<older@x>'];
    const r = buildReply(msg, 'Дякую!', true, p.account);
    expect(r.to).toEqual(['Олена Коваль <olena@example.com>']);
    expect(r.cc).toEqual(['Ivan <ivan@example.com>']);
    expect(r.subject).toBe('Re: Зустріч у четвер о 10:00');
    expect(r.inReplyTo).toBe(msg.messageId);
    expect(r.references).toEqual(['<older@x>', msg.messageId!]);
    expect(r.text).toStartWith('Дякую!');
    expect(r.text).toContain('> Привіт!');
  });
});

describe('HTTP API', () => {
  let ctx: ReturnType<typeof startServer>;
  const auth = { authorization: `Bearer ${TOKEN}` };
  beforeAll(() => {
    ctx = startServer();
  });
  afterAll(() => ctx.server.stop(true));

  test('serves the app shell without auth', async () => {
    const res = await fetch(`${ctx.base}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Pocket Mail');
    expect((await fetch(`${ctx.base}/../package.json`)).status).toBe(404);
  });

  test('rejects API calls without the token', async () => {
    expect((await fetch(`${ctx.base}/api/folders`)).status).toBe(401);
    expect((await fetch(`${ctx.base}/api/folders`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
  });

  test('lists, filters, reads and flags mail', async () => {
    const list = await (await fetch(`${ctx.base}/api/messages?folder=INBOX`, { headers: auth })).json();
    expect(list.total).toBe(4);
    expect(list.messages[0].subject).toBe('Зустріч у четвер о 10:00');

    const unread = await (await fetch(`${ctx.base}/api/messages?folder=INBOX&unread=1`, { headers: auth })).json();
    expect(unread.messages.every((m: { seen: boolean }) => !m.seen)).toBe(true);
    const flagged = await (await fetch(`${ctx.base}/api/messages?folder=INBOX&flagged=1`, { headers: auth })).json();
    expect(flagged.total).toBe(1);
    const found = await (await fetch(`${ctx.base}/api/messages?folder=INBOX&q=invoice`, { headers: auth })).json();
    expect(found.messages.map((m: { uid: number }) => m.uid)).toEqual([3]);

    const { message } = await (await fetch(`${ctx.base}/api/message?folder=INBOX&uid=3`, { headers: auth })).json();
    expect(message.attachments[0].filename).toBe('FV-09-2026.txt');

    const att = await fetch(`${ctx.base}/api/attachment?folder=INBOX&uid=3&index=0&token=${TOKEN}`);
    expect(att.status).toBe(200);
    expect(await att.text()).toContain('1 250,00 PLN');

    const patch = await fetch(`${ctx.base}/api/message`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ folder: 'INBOX', uid: 1, seen: true }),
    });
    expect(patch.status).toBe(200);
    expect((await ctx.provider.getMessage('INBOX', 1))!.seen).toBe(true);
  });

  test('sends, replies, and validates input', async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${ctx.base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    expect((await post('/api/send', { subject: 'x' })).status).toBe(400);
    const sent = await post('/api/send', { to: 'a@example.com, b@example.com', subject: 'Hi', text: 'Hello' });
    expect(sent.status).toBe(200);
    expect(ctx.provider.outbox.at(-1)!.to).toEqual(['a@example.com', 'b@example.com']);

    const reply = await post('/api/reply', { folder: 'INBOX', uid: 1, text: 'Ok', replyAll: false });
    expect(reply.status).toBe(200);
    expect(ctx.provider.outbox.at(-1)!.to).toEqual(['Олена Коваль <olena@example.com>']);

    const fwd = await post('/api/forward', { folder: 'INBOX', uid: 3, to: ['boss@example.com'], text: 'FYI' });
    expect(fwd.status).toBe(200);
    expect(ctx.provider.outbox.at(-1)!.attachments?.[0].filename).toBe('FV-09-2026.txt');

    expect((await post('/api/delete', { folder: 'INBOX', uid: 4 })).status).toBe(200);
    const trash = await ctx.provider.listMessages({ folder: 'Trash' });
    expect(trash.messages.map((m) => m.uid)).toContain(4);
  });
});

describe('MCP endpoint (what Claude connects to)', () => {
  let ctx: ReturnType<typeof startServer>;
  beforeAll(() => {
    ctx = startServer();
  });
  afterAll(() => ctx.server.stop(true));

  test('requires the token', async () => {
    const res = await fetch(`${ctx.base}/mcp`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    await expect(mcpClient(`${ctx.base}/mcp/wrong-token`)).rejects.toThrow();
  });

  test('works with a Bearer header and with the token in the URL', async () => {
    for (const client of [await mcpClient(`${ctx.base}/mcp`, { authorization: `Bearer ${TOKEN}` }), await mcpClient(`${ctx.base}/mcp/${TOKEN}`)]) {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(['list_emails', 'search_emails', 'read_email', 'send_email', 'reply_to_email', 'forward_email', 'delete_email']),
      );
      await client.close();
    }
  });

  test('Claude can find, read, answer and send mail', async () => {
    const client = await mcpClient(`${ctx.base}/mcp/${TOKEN}`);

    const list = toolText(await client.callTool({ name: 'list_emails', arguments: { unread_only: true } }));
    expect(list).toContain('Зустріч у четвер');
    expect(list).toContain('UNREAD');

    const search = toolText(await client.callTool({ name: 'search_emails', arguments: { query: 'посилка' } }));
    expect(search).toContain('uid=2');

    const read = toolText(await client.callTool({ name: 'read_email', arguments: { uid: 3, mark_as_read: true } }));
    expect(read).toContain('Please find the September invoice');
    expect(read).toContain('[0] FV-09-2026.txt');
    expect((await ctx.provider.getMessage('INBOX', 3))!.seen).toBe(true);

    const att = toolText(await client.callTool({ name: 'get_attachment', arguments: { uid: 3, index: 0 } }));
    expect(att).toContain('Total: 1 250,00 PLN');

    const reply = toolText(await client.callTool({ name: 'reply_to_email', arguments: { uid: 1, body: 'Підтверджую' } }));
    expect(reply).toContain('olena@example.com');
    expect(ctx.provider.outbox.at(-1)!.subject).toBe('Re: Зустріч у четвер о 10:00');

    const send = toolText(
      await client.callTool({ name: 'send_email', arguments: { to: ['x@example.com'], subject: 'Test', body: 'Body' } }),
    );
    expect(send).toContain('Sent.');

    const missing = await client.callTool({ name: 'read_email', arguments: { uid: 999 } });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  test('read-only mode hides tools that change mail', async () => {
    const ro = startServer({ readOnlyMcp: true });
    const client = await mcpClient(`${ro.base}/mcp/${TOKEN}`);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('read_email');
    expect(names).not.toContain('send_email');
    expect(names).not.toContain('delete_email');
    await client.close();
    ro.server.stop(true);
  });
});
