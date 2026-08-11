import { McpServer } from '@modelcontextprotocol/server';

import { registerAllTools } from './tools/index.js';
import type { ToolDependencies } from './tools/types.js';

export function createClickUpMcpServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer(
    { name: 'custom-clickup-mcp', version: '0.1.0' },
    { capabilities: { tools: { listChanged: false } } },
  );
  registerAllTools(server, dependencies);
  return server;
}
