// Real mailbox access: IMAP for reading, SMTP for sending.
// Works with any provider that offers IMAP/SMTP (Gmail, Outlook.com, ukr.net, iCloud, ...).

import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import nodemailer, { type Transporter } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import type { AppConfig } from './config.ts';
import type {
  Address,
  AttachmentData,
  Folder,
  ListOptions,
  ListResult,
  MailProvider,
  Message,
  MessageSummary,
  SendRequest,
  SendResult,
} from './types.ts';

const ROLE_BY_SPECIAL_USE: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk',
  '\\Archive': 'archive',
  '\\All': 'all',
  '\\Flagged': 'flagged',
};

const PREVIEW_BYTES = 12_000;

export function addressList(obj: AddressObject | AddressObject[] | undefined): Address[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  return list.flatMap((o) =>
    o.value.flatMap((a) =>
      a.group ? a.group.map((g) => ({ name: g.name || undefined, address: g.address || '' })) : [{ name: a.name || undefined, address: a.address || '' }],
    ),
  );
}

export function makePreview(text: string | undefined): string {
  return (text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function envelopeAddress(list: { name?: string; address?: string }[] | undefined): Address[] {
  return (list || []).map((a) => ({ name: a.name || undefined, address: a.address || '' }));
}

function hasAttachment(node: FetchMessageObject['bodyStructure']): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  return (node.childNodes || []).some(hasAttachment);
}

export class ImapProvider implements MailProvider {
  readonly account: Address;
  private client: ImapFlow | null = null;
  private connecting: Promise<ImapFlow> | null = null;
  private transporter: Transporter;
  private folderCache: { at: number; folders: Folder[] } | null = null;

  constructor(private cfg: AppConfig) {
    if (!cfg.imap || !cfg.smtp) throw new Error('IMAP/SMTP settings are required');
    this.account = { name: cfg.fromName, address: cfg.fromAddress };
    this.transporter = nodemailer.createTransport({
      host: cfg.smtp.host,
      port: cfg.smtp.port,
      secure: cfg.smtp.secure,
      auth: { user: cfg.smtp.user, pass: cfg.smtp.pass },
    });
  }

  private async imap(): Promise<ImapFlow> {
    if (this.client?.usable) return this.client;
    if (this.connecting) return this.connecting;
    const imap = this.cfg.imap!;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.pass },
      logger: false,
    });
    client.on('close', () => {
      if (this.client === client) this.client = null;
    });
    // Without a listener, a dropped socket would crash the process.
    client.on('error', (err: Error) => console.error('[imap]', err.message));
    this.connecting = client
      .connect()
      .then(() => {
        this.client = client;
        return client;
      })
      .finally(() => {
        this.connecting = null;
      });
    return this.connecting;
  }

  private async withMailbox<T>(folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.imap();
    const lock = await c.getMailboxLock(folder);
    try {
      return await fn(c);
    } finally {
      lock.release();
    }
  }

  async listFolders(): Promise<Folder[]> {
    if (this.folderCache && Date.now() - this.folderCache.at < 30_000) return this.folderCache.folders;
    const c = await this.imap();
    const boxes: ListResponse[] = await c.list({ statusQuery: { messages: true, unseen: true } });
    const folders = boxes
      .filter((b) => !b.flags.has('\\Noselect'))
      .map((b) => ({
        path: b.path,
        name: b.path.toUpperCase() === 'INBOX' ? 'Inbox' : b.name,
        role: (b.specialUse && ROLE_BY_SPECIAL_USE[b.specialUse]) || (b.path.toUpperCase() === 'INBOX' ? 'inbox' : undefined),
        unread: b.status?.unseen,
        total: b.status?.messages,
      }));
    this.folderCache = { at: Date.now(), folders };
    return folders;
  }

  private async folderByRole(role: string): Promise<Folder | undefined> {
    return (await this.listFolders()).find((f) => f.role === role);
  }

  async listMessages(opts: ListOptions): Promise<ListResult> {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25));
    return this.withMailbox(opts.folder, async (c) => {
      const criteria: Record<string, unknown> = {};
      if (opts.unreadOnly) criteria.seen = false;
      if (opts.flaggedOnly) criteria.flagged = true;
      if (opts.search) {
        const q = opts.search;
        criteria.or = [{ subject: q }, { from: q }, { to: q }, { body: q }];
      }
      const found = await c.search(Object.keys(criteria).length ? criteria : { all: true }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).sort((a, b) => b - a);
      const slice = uids.slice((page - 1) * pageSize, page * pageSize);
      const messages: MessageSummary[] = [];
      if (slice.length) {
        for await (const m of c.fetch(
          slice.join(','),
          { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, source: { maxLength: PREVIEW_BYTES } },
          { uid: true },
        )) {
          messages.push(await this.summarize(opts.folder, m));
        }
      }
      messages.sort((a, b) => b.uid - a.uid);
      return { folder: opts.folder, total: uids.length, page, pageSize, messages };
    });
  }

  private async summarize(folder: string, m: FetchMessageObject): Promise<MessageSummary> {
    let preview = '';
    if (m.source) {
      try {
        const parsed = await simpleParser(m.source, { skipImageLinks: true, skipTextToHtml: true });
        preview = makePreview(parsed.text);
      } catch {
        // Truncated source may not parse; the preview is cosmetic.
      }
    }
    const env = m.envelope;
    const date = env?.date || m.internalDate;
    return {
      uid: m.uid,
      folder,
      messageId: env?.messageId,
      subject: env?.subject || '(без теми)',
      from: envelopeAddress(env?.from)[0],
      to: envelopeAddress(env?.to),
      date: date ? new Date(date).toISOString() : new Date(0).toISOString(),
      seen: m.flags?.has('\\Seen') ?? false,
      flagged: m.flags?.has('\\Flagged') ?? false,
      hasAttachments: hasAttachment(m.bodyStructure),
      preview,
    };
  }

  private async fetchParsed(folder: string, uid: number): Promise<{ parsed: ParsedMail; flags: Set<string> } | null> {
    return this.withMailbox(folder, async (c) => {
      const m = await c.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
      if (!m || !m.source) return null;
      return { parsed: await simpleParser(m.source), flags: m.flags || new Set() };
    });
  }

  async getMessage(folder: string, uid: number): Promise<Message | null> {
    const got = await this.fetchParsed(folder, uid);
    if (!got) return null;
    const { parsed, flags } = got;
    const refs = parsed.references ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references]) : [];
    return {
      uid,
      folder,
      messageId: parsed.messageId,
      subject: parsed.subject || '(без теми)',
      from: addressList(parsed.from)[0],
      to: addressList(parsed.to),
      cc: addressList(parsed.cc),
      replyTo: addressList(parsed.replyTo),
      references: refs,
      date: (parsed.date || new Date(0)).toISOString(),
      seen: flags.has('\\Seen'),
      flagged: flags.has('\\Flagged'),
      hasAttachments: parsed.attachments.length > 0,
      preview: makePreview(parsed.text),
      text: parsed.text || '',
      html: parsed.html || undefined,
      attachments: parsed.attachments.map((a, index) => ({
        index,
        filename: a.filename || `attachment-${index + 1}`,
        contentType: a.contentType,
        size: a.size,
      })),
    };
  }

  async getAttachment(folder: string, uid: number, index: number): Promise<AttachmentData | null> {
    const got = await this.fetchParsed(folder, uid);
    const a = got?.parsed.attachments[index];
    if (!a) return null;
    return { filename: a.filename || `attachment-${index + 1}`, contentType: a.contentType, content: new Uint8Array(a.content) };
  }

  async setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    await this.withMailbox(folder, async (c) => {
      for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']] as const) {
        const v = flags[key];
        if (v === true) await c.messageFlagsAdd(String(uid), [flag], { uid: true });
        if (v === false) await c.messageFlagsRemove(String(uid), [flag], { uid: true });
      }
    });
    this.folderCache = null;
  }

  async move(folder: string, uid: number, target: string): Promise<void> {
    await this.withMailbox(folder, (c) => c.messageMove(String(uid), target, { uid: true }));
    this.folderCache = null;
  }

  async remove(folder: string, uid: number): Promise<void> {
    const trash = await this.folderByRole('trash');
    if (!trash || trash.path === folder) {
      await this.withMailbox(folder, (c) => c.messageDelete(String(uid), { uid: true }));
    } else {
      await this.move(folder, uid, trash.path);
    }
    this.folderCache = null;
  }

  async send(req: SendRequest): Promise<SendResult> {
    const mail = {
      from: this.account.name ? { name: this.account.name, address: this.account.address } : this.account.address,
      to: req.to,
      cc: req.cc,
      bcc: req.bcc,
      subject: req.subject,
      text: req.text,
      html: req.html,
      inReplyTo: req.inReplyTo,
      references: req.references,
      attachments: (req.attachments || []).map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        content: Buffer.from(a.content, 'base64'),
      })),
    };
    const composer = new MailComposer(mail);
    const built = composer.compile();
    const { from, to } = built.getEnvelope();
    const messageId = built.messageId();
    const raw: Buffer = await built.build();
    const info: { accepted?: unknown[]; rejected?: unknown[] } = await this.transporter.sendMail({
      envelope: { from: from || this.account.address, to },
      raw,
    });

    await this.saveToSent(raw).catch((err) => console.error('[imap] could not save to Sent:', err.message));

    return {
      messageId,
      accepted: (info.accepted || []).map(String),
      rejected: (info.rejected || []).map(String),
    };
  }

  // Gmail and Office 365 store sent mail on their own; everyone else needs an APPEND.
  private async saveToSent(raw: Buffer): Promise<void> {
    const mode = (process.env.SAVE_SENT || 'auto').toLowerCase();
    const smtpHost = this.cfg.smtp!.host;
    const selfSaving = /gmail\.com$|office365\.com$|outlook\.com$/.test(smtpHost);
    if (mode === 'never' || (mode === 'auto' && selfSaving)) return;
    const sent = await this.folderByRole('sent');
    if (!sent) return;
    const c = await this.imap();
    await c.append(sent.path, raw, ['\\Seen']);
    this.folderCache = null;
  }

  async close(): Promise<void> {
    await this.client?.logout().catch(() => {});
    this.transporter.close();
  }
}
