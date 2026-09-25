// In-memory mailbox with sample messages. Used by `bun run demo` and the tests,
// so the app and the Claude connector can be tried without real credentials.

import type {
  Address,
  AttachmentData,
  Folder,
  ListOptions,
  ListResult,
  MailProvider,
  Message,
  SendRequest,
  SendResult,
} from './types.ts';

interface Stored extends Message {
  attachmentData: Uint8Array[];
}

const FOLDERS: Folder[] = [
  { path: 'INBOX', name: 'Inbox', role: 'inbox' },
  { path: 'Sent', name: 'Sent', role: 'sent' },
  { path: 'Drafts', name: 'Drafts', role: 'drafts' },
  { path: 'Archive', name: 'Archive', role: 'archive' },
  { path: 'Junk', name: 'Junk', role: 'junk' },
  { path: 'Trash', name: 'Trash', role: 'trash' },
];

function parseAddr(s: string): Address {
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1] || undefined, address: m[2] } : { address: s.trim() };
}

export class DemoProvider implements MailProvider {
  readonly account: Address = { name: 'Demo User', address: 'me@example.com' };
  private store = new Map<string, Stored[]>();
  private nextUid = 1;
  readonly outbox: SendRequest[] = [];

  constructor() {
    for (const f of FOLDERS) this.store.set(f.path, []);
    const now = Date.now();
    const h = 3_600_000;
    this.seed('INBOX', {
      from: { name: 'Олена Коваль', address: 'olena@example.com' },
      subject: 'Зустріч у четвер о 10:00',
      text: 'Привіт!\n\nПідтверджую зустріч у четвер о 10:00 в офісі на Хрещатику. Візьми, будь ласка, ноутбук з презентацією.\n\nДякую,\nОлена',
      date: now - 0.5 * h,
    });
    this.seed('INBOX', {
      from: { name: 'Nova Poshta', address: 'noreply@novaposhta.example' },
      subject: 'Ваша посилка прибула у відділення №12',
      text: 'Посилка 20450000000000 прибула у відділення №12. Отримати можна до 30 вересня.',
      html: '<h2 style="color:#d32f2f">Посилка прибула</h2><p>Посилка <b>20450000000000</b> прибула у відділення №12.</p><p>Отримати можна до 30 вересня.</p>',
      date: now - 3 * h,
      seen: true,
    });
    this.seed('INBOX', {
      from: { name: 'Anna Nowak', address: 'anna.nowak@example.pl' },
      subject: 'Invoice FV/09/2026 attached',
      text: 'Hi,\n\nPlease find the September invoice attached. Payment due in 14 days.\n\nBest regards,\nAnna',
      date: now - 26 * h,
      flagged: true,
      attachment: { filename: 'FV-09-2026.txt', contentType: 'text/plain', body: 'Invoice FV/09/2026\nTotal: 1 250,00 PLN\n' },
    });
    this.seed('INBOX', {
      from: { name: 'GitHub', address: 'notifications@github.example' },
      subject: '[gstack] New comment on your pull request',
      text: 'Someone commented on your pull request: "Looks good, just one nit on the README."',
      date: now - 50 * h,
      seen: true,
    });
    this.seed('Sent', {
      from: this.account,
      to: [{ name: 'Олена Коваль', address: 'olena@example.com' }],
      subject: 'Re: План на тиждень',
      text: 'Олено, дякую! План погоджено.',
      date: now - 72 * h,
      seen: true,
    });
  }

  private seed(
    folder: string,
    m: {
      from: Address;
      to?: Address[];
      subject: string;
      text: string;
      html?: string;
      date: number;
      seen?: boolean;
      flagged?: boolean;
      attachment?: { filename: string; contentType: string; body: string };
    },
  ): Stored {
    const uid = this.nextUid++;
    const data = m.attachment ? [new TextEncoder().encode(m.attachment.body)] : [];
    const stored: Stored = {
      uid,
      folder,
      messageId: `<demo-${uid}@example.com>`,
      subject: m.subject,
      from: m.from,
      to: m.to || [this.account],
      cc: [],
      replyTo: [],
      references: [],
      date: new Date(m.date).toISOString(),
      seen: m.seen ?? false,
      flagged: m.flagged ?? false,
      hasAttachments: data.length > 0,
      preview: m.text.replace(/\s+/g, ' ').slice(0, 160),
      text: m.text,
      html: m.html,
      attachments: m.attachment
        ? [{ index: 0, filename: m.attachment.filename, contentType: m.attachment.contentType, size: data[0].length }]
        : [],
      attachmentData: data,
    };
    this.store.get(folder)!.push(stored);
    return stored;
  }

  private find(folder: string, uid: number): Stored | undefined {
    return this.store.get(folder)?.find((m) => m.uid === uid);
  }

  async listFolders(): Promise<Folder[]> {
    return FOLDERS.map((f) => {
      const msgs = this.store.get(f.path) || [];
      return { ...f, total: msgs.length, unread: msgs.filter((m) => !m.seen).length };
    });
  }

  async listMessages(opts: ListOptions): Promise<ListResult> {
    const page = Math.max(1, opts.page || 1);
    const pageSize = Math.min(100, Math.max(1, opts.pageSize || 25));
    let msgs = [...(this.store.get(opts.folder) || [])];
    if (opts.unreadOnly) msgs = msgs.filter((m) => !m.seen);
    if (opts.flaggedOnly) msgs = msgs.filter((m) => m.flagged);
    if (opts.search) {
      const q = opts.search.toLowerCase();
      msgs = msgs.filter((m) =>
        [m.subject, m.text, m.from?.name, m.from?.address, ...m.to.map((t) => t.address)].some((s) => s?.toLowerCase().includes(q)),
      );
    }
    msgs.sort((a, b) => b.date.localeCompare(a.date));
    const slice = msgs.slice((page - 1) * pageSize, page * pageSize);
    return {
      folder: opts.folder,
      total: msgs.length,
      page,
      pageSize,
      messages: slice.map(({ text, html, cc, replyTo, references, attachments, attachmentData, ...summary }) => summary),
    };
  }

  async getMessage(folder: string, uid: number): Promise<Message | null> {
    const m = this.find(folder, uid);
    if (!m) return null;
    const { attachmentData, ...msg } = m;
    return structuredClone(msg);
  }

  async getAttachment(folder: string, uid: number, index: number): Promise<AttachmentData | null> {
    const m = this.find(folder, uid);
    const info = m?.attachments[index];
    if (!m || !info) return null;
    return { filename: info.filename, contentType: info.contentType, content: m.attachmentData[index] };
  }

  async setFlags(folder: string, uid: number, flags: { seen?: boolean; flagged?: boolean }): Promise<void> {
    const m = this.find(folder, uid);
    if (!m) throw new Error('Message not found');
    if (flags.seen !== undefined) m.seen = flags.seen;
    if (flags.flagged !== undefined) m.flagged = flags.flagged;
  }

  async move(folder: string, uid: number, target: string): Promise<void> {
    const src = this.store.get(folder);
    const dst = this.store.get(target);
    if (!src || !dst) throw new Error('Folder not found');
    const i = src.findIndex((m) => m.uid === uid);
    if (i < 0) throw new Error('Message not found');
    const [m] = src.splice(i, 1);
    m.folder = target;
    dst.push(m);
  }

  async remove(folder: string, uid: number): Promise<void> {
    if (folder === 'Trash') {
      const src = this.store.get(folder)!;
      const i = src.findIndex((m) => m.uid === uid);
      if (i < 0) throw new Error('Message not found');
      src.splice(i, 1);
    } else {
      await this.move(folder, uid, 'Trash');
    }
  }

  async send(req: SendRequest): Promise<SendResult> {
    this.outbox.push(req);
    const stored = this.seed('Sent', {
      from: this.account,
      to: req.to.map(parseAddr),
      subject: req.subject,
      text: req.text || (req.html || '').replace(/<[^>]+>/g, ''),
      html: req.html,
      date: Date.now(),
      seen: true,
    });
    return { messageId: stored.messageId!, accepted: [...req.to, ...(req.cc || []), ...(req.bcc || [])], rejected: [] };
  }

  async close(): Promise<void> {}
}
