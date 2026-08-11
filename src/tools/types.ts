import type { AppConfig } from '../config.js';
import type { ClickUpClient } from '../clickup/client.js';
import type { Logger } from '../logging.js';
import type { ConfirmationService } from '../policies/confirmation.js';
import type { MemoryCache } from '../utils/cache.js';

export interface ToolDependencies {
  client: ClickUpClient;
  config: AppConfig;
  logger: Logger;
  ensureAuthenticated?: () => Promise<void>;
  confirmations: ConfirmationService;
  cache: MemoryCache;
}
