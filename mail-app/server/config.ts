// Runtime configuration, read from environment variables (or a .env file,
// which Bun loads automatically from the working directory).

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
}

export interface AppConfig {
  port: number;
  host: string;
  /** Shared secret for the web app and the HTTP MCP endpoint. */
  token: string;
  demo: boolean;
  fromName?: string;
  fromAddress: string;
  imap?: ImapConfig;
  smtp?: SmtpConfig;
}

// Well-known servers so most people only need MAIL_USER + MAIL_PASSWORD.
const PRESETS: Record<string, { imap: string; smtp: string; smtpPort?: number }> = {
  'gmail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  'googlemail.com': { imap: 'imap.gmail.com', smtp: 'smtp.gmail.com' },
  'outlook.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  'hotmail.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  'live.com': { imap: 'outlook.office365.com', smtp: 'smtp.office365.com', smtpPort: 587 },
  'yahoo.com': { imap: 'imap.mail.yahoo.com', smtp: 'smtp.mail.yahoo.com' },
  'icloud.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  'me.com': { imap: 'imap.mail.me.com', smtp: 'smtp.mail.me.com', smtpPort: 587 },
  'ukr.net': { imap: 'imap.ukr.net', smtp: 'smtp.ukr.net' },
  'i.ua': { imap: 'imap.i.ua', smtp: 'smtp.i.ua' },
  'meta.ua': { imap: 'imap.meta.ua', smtp: 'smtp.meta.ua' },
  'wp.pl': { imap: 'imap.wp.pl', smtp: 'smtp.wp.pl' },
  'o2.pl': { imap: 'poczta.o2.pl', smtp: 'poczta.o2.pl' },
  'onet.pl': { imap: 'imap.poczta.onet.pl', smtp: 'smtp.poczta.onet.pl' },
  'interia.pl': { imap: 'poczta.interia.pl', smtp: 'poczta.interia.pl' },
};

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const demo = bool(env.MAIL_DEMO, false);
  const port = Number(env.PORT || 8787);
  const host = env.HOST || '0.0.0.0';
  const token = env.MAIL_APP_TOKEN || (demo ? 'demo' : '');

  if (demo) {
    return { port, host, token, demo, fromName: 'Demo User', fromAddress: 'me@example.com' };
  }

  const user = env.MAIL_USER || '';
  const pass = env.MAIL_PASSWORD || '';
  const missing = [
    !user && 'MAIL_USER',
    !pass && 'MAIL_PASSWORD',
    !token && 'MAIL_APP_TOKEN',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing required settings: ${missing.join(', ')}. Copy .env.example to .env and fill it in, ` +
        'or run with MAIL_DEMO=1 to try the app with sample mail.',
    );
  }
  if (token.length < 16) {
    throw new Error('MAIL_APP_TOKEN must be at least 16 characters. Generate one with: openssl rand -hex 24');
  }

  const domain = user.split('@')[1]?.toLowerCase() || '';
  const preset = PRESETS[domain];
  const imapHost = env.IMAP_HOST || preset?.imap;
  const smtpHost = env.SMTP_HOST || preset?.smtp;
  if (!imapHost || !smtpHost) {
    throw new Error(`No preset for "${domain}". Set IMAP_HOST and SMTP_HOST in .env.`);
  }
  const imapPort = Number(env.IMAP_PORT || 993);
  const smtpPort = Number(env.SMTP_PORT || preset?.smtpPort || 465);

  return {
    port,
    host,
    token,
    demo,
    fromName: env.MAIL_FROM_NAME || undefined,
    fromAddress: env.MAIL_FROM || user,
    imap: {
      host: imapHost,
      port: imapPort,
      secure: bool(env.IMAP_SECURE, imapPort === 993),
      user: env.IMAP_USER || user,
      pass: env.IMAP_PASSWORD || pass,
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      secure: bool(env.SMTP_SECURE, smtpPort === 465),
      user: env.SMTP_USER || user,
      pass: env.SMTP_PASSWORD || pass,
    },
  };
}
