// Starts the phone app + API + remote MCP endpoint.
import { createFetchHandler } from './app.ts';
import { loadConfig } from './config.ts';
import { createProvider, loadDotEnv } from './provider.ts';

loadDotEnv();
const cfg = loadConfig();
const provider = createProvider(cfg);
const readOnlyMcp = ['1', 'true', 'yes'].includes((process.env.MCP_READ_ONLY || '').toLowerCase());

const server = Bun.serve({
  port: cfg.port,
  hostname: cfg.host,
  maxRequestBodySize: 35 * 1024 * 1024,
  idleTimeout: 120,
  fetch: createFetchHandler(provider, { token: cfg.token, readOnlyMcp }),
});

const base = `http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${server.port}`;
console.log(`Pocket Mail ${cfg.demo ? '(DEMO mailbox) ' : ''}for ${cfg.fromAddress}`);
console.log(`  Phone app:  ${base}/`);
console.log(`  Claude MCP: ${base}/mcp  (Authorization: Bearer <MAIL_APP_TOKEN>)`);
if (readOnlyMcp) console.log('  MCP is read-only: Claude can read but not send, move or delete.');

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    server.stop();
    await provider.close();
    process.exit(0);
  });
}
