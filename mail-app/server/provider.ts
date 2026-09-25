import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AppConfig } from './config.ts';
import { DemoProvider } from './demo-provider.ts';
import { ImapProvider } from './imap-provider.ts';
import type { MailProvider } from './types.ts';

/**
 * Loads mail-app/.env regardless of the current directory. Claude Desktop starts the
 * stdio server from an arbitrary cwd, where Bun's automatic .env loading would miss it.
 * Values already present in the environment win.
 */
export function loadDotEnv(file = resolve(import.meta.dir, '..', '.env')): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function createProvider(cfg: AppConfig): MailProvider {
  return cfg.demo ? new DemoProvider() : new ImapProvider(cfg);
}
