#!/usr/bin/env node

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { ClickUpClient } from './clickup/client.js';
import { loadConfig } from './config.js';
import { normalizeError } from './errors.js';
import { createStderrLogger } from './logging.js';
import { ConfirmationService } from './policies/confirmation.js';
import { createClickUpMcpServer } from './server.js';
import { MemoryCache } from './utils/cache.js';

function main(): void {
  const logger = createStderrLogger();
  const config = loadConfig();
  const client = new ClickUpClient(config, logger);
  let authentication: Promise<void> | undefined;
  const ensureAuthenticated = (): Promise<void> => {
    authentication ??= client
      .validateAuthentication()
      .then((auth) => {
        logger.info('clickup.authenticated', {
          user_id: auth.userId,
          workspace_count: auth.workspaceIds.length,
        });
      })
      .catch((error: unknown) => {
        authentication = undefined;
        throw error;
      });
    return authentication;
  };

  const dependencies = {
    client,
    config,
    logger,
    ensureAuthenticated,
    confirmations: new ConfirmationService(),
    cache: new MemoryCache(),
  };
  const handle = serveStdio(() => createClickUpMcpServer(dependencies), {
    onerror: () => logger.error('mcp.transport', { code: 'MCP_TRANSPORT_ERROR' }),
  });

  const shutdown = (): void => {
    void handle.close().finally(() => {
      dependencies.cache.clear();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

try {
  main();
} catch (error: unknown) {
  const normalized = normalizeError(error);
  process.stderr.write(
    `${JSON.stringify({ level: 'error', event: 'startup.failed', code: normalized.code })}\n`,
  );
  process.exitCode = 1;
}
