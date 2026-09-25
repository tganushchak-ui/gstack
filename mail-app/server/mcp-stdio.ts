// Local MCP server over stdio, for Claude Desktop and Claude Code.
// Talks to the mailbox directly; the web server does not need to be running.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createMcpServer } from './mcp.ts';
import { createProvider, loadDotEnv } from './provider.ts';

loadDotEnv();
// stdio has no network exposure, so the web token is optional here.
const cfg = loadConfig({ ...process.env, MAIL_APP_TOKEN: process.env.MAIL_APP_TOKEN || 'stdio-local-no-token-needed' });
const provider = createProvider(cfg);
const readOnly = ['1', 'true', 'yes'].includes((process.env.MCP_READ_ONLY || '').toLowerCase());
const server = createMcpServer(provider, { readOnly });
await server.connect(new StdioServerTransport());
console.error(`pocket-mail MCP ready for ${cfg.fromAddress}${readOnly ? ' (read-only)' : ''}`);
