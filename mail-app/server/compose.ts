// Reply / forward construction shared by the web app API and the MCP tools.

import type { Address, MailProvider, Message, SendRequest } from './types.ts';

export function formatAddress(a?: Address): string {
  if (!a) return '';
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function prefixed(prefix: string, subject: string): string {
  const re = new RegExp(`^\\s*${prefix}:`, 'i');
  return re.test(subject) ? subject : `${prefix}: ${subject}`;
}

function quote(msg: Message): string {
  const when = new Date(msg.date).toLocaleString('uk-UA', { timeZone: process.env.TZ || 'Europe/Kyiv' });
  const body = msg.text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  return `\n\n${when}, ${formatAddress(msg.from)} пише:\n${body}`;
}

export function buildReply(msg: Message, body: string, replyAll: boolean, self: Address): SendRequest {
  const me = self.address.toLowerCase();
  const primary = (msg.replyTo.length ? msg.replyTo : msg.from ? [msg.from] : []).filter((a) => a.address);
  // Replying to our own sent message goes back to its original recipients.
  const to = primary.every((a) => a.address.toLowerCase() === me) ? msg.to : primary;
  const seen = new Set(to.map((a) => a.address.toLowerCase()));
  seen.add(me);
  const cc = replyAll
    ? [...msg.to, ...msg.cc].filter((a) => {
        const key = a.address.toLowerCase();
        if (!a.address || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
    : [];
  return {
    to: to.map(formatAddress),
    cc: cc.length ? cc.map(formatAddress) : undefined,
    subject: prefixed('Re', msg.subject),
    text: body + quote(msg),
    inReplyTo: msg.messageId,
    references: [...msg.references, ...(msg.messageId ? [msg.messageId] : [])],
  };
}

export async function buildForward(
  provider: MailProvider,
  msg: Message,
  to: string[],
  note: string,
  includeAttachments = true,
): Promise<SendRequest> {
  const header = [
    '---------- Переслане повідомлення ----------',
    `Від: ${formatAddress(msg.from)}`,
    `Дата: ${new Date(msg.date).toUTCString()}`,
    `Тема: ${msg.subject}`,
    `Кому: ${msg.to.map(formatAddress).join(', ')}`,
  ].join('\n');
  const attachments = [];
  if (includeAttachments) {
    for (const a of msg.attachments) {
      const data = await provider.getAttachment(msg.folder, msg.uid, a.index);
      if (data) {
        attachments.push({
          filename: data.filename,
          contentType: data.contentType,
          content: Buffer.from(data.content).toString('base64'),
        });
      }
    }
  }
  return {
    to,
    subject: prefixed('Fwd', msg.subject),
    text: `${note}\n\n${header}\n\n${msg.text}`,
    attachments: attachments.length ? attachments : undefined,
  };
}
