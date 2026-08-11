# Custom ClickUp MCP

Local MCP server for the essential ClickUp workflows. It runs over `stdio`, uses one ClickUp personal API token per process, and exposes a deliberately bounded P0 tool set.

## Requirements

- Node.js 20 or newer
- A ClickUp personal API token
- Access to a disposable ClickUp Workspace for smoke tests

## Install and build

```bash
npm ci
npm run build
```

Set secrets through the process environment or the MCP client's secret store. Do not commit a real token to an MCP configuration file.

```bash
export CLICKUP_API_TOKEN="pk_replace_me"
export CLICKUP_DEFAULT_WORKSPACE_ID="123456"
npm start
```

The process communicates through standard input/output. Seeing no ordinary output on `stdout` is expected; operational logs are JSON lines on `stderr`.

## MCP client configuration

Use the absolute path to the built entry point:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "node",
      "args": ["/absolute/path/to/custom-clickup-mcp/dist/index.js"],
      "env": {
        "CLICKUP_API_TOKEN": "<from-your-client-secret-store>",
        "CLICKUP_DEFAULT_WORKSPACE_ID": "123456"
      }
    }
  }
}
```

Any client that supports MCP over `stdio` can launch the same command. The SDK serves the current MCP protocol and negotiates the supported legacy era by default.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `CLICKUP_API_TOKEN` | yes | — | Personal ClickUp API token. Never logged or persisted. |
| `CLICKUP_DEFAULT_WORKSPACE_ID` | no | — | Default Workspace when a tool does not receive `workspace_id`. |
| `CLICKUP_TOOL_PROFILE` | no | `full` | Tool catalog: all 32 tools with `full`, or the compact common-workflow catalog with `core`. |
| `CLICKUP_ENABLE_DESTRUCTIVE` | no | `false` | Allows confirmed Task deletion and Custom Field value removal. |
| `CLICKUP_ENABLE_BULK_WRITES` | no | `false` | Allows confirmed bulk task writes and multi-field Custom Field writes. |
| `CLICKUP_BULK_MAX_ITEMS` | no | `25` | Per-call bulk limit; maximum allowed value is 100. |
| `CLICKUP_SEARCH_MAX_PAGES` | no | `5` | Default Task pages scanned; maximum allowed value is 20. |
| `CLICKUP_REQUEST_TIMEOUT_MS` | no | `15000` | Timeout for each upstream API request. |

`.env.example` documents the same values, but the server intentionally does not load `.env` files itself.

## Tools

The default `full` profile exposes exactly 32 tools in P0. Set
`CLICKUP_TOOL_PROFILE=core` to expose only the common search, Task, comment, Tag,
hierarchy, and assignee-resolution workflow. The compact profile contains 14 tools and
reduces the tool-discovery payload without changing any tool's request or response shape.

### Search

- `search_workspace`
- `search_tasks_by_task_type`
- `search_tasks_by_tag`

`search_workspace` performs a bounded API sweep over Tasks, Spaces, Folders, and Lists. It does not search Docs. A truncated result includes a continuation cursor and scan counters; it never walks an unbounded Workspace implicitly.

### Task management

- `create_task`
- `get_task`
- `update_task`
- `set_task_custom_fields`
- `delete_task`
- `create_bulk_tasks`
- `update_bulk_tasks`

`create_task` and `update_task` accept either `description` for plain text or
`markdown_description` for formatted Markdown, but not both. The server maps
`markdown_description` to ClickUp's upstream `markdown_content` field. The same input
contract applies to items in `create_bulk_tasks` and `update_bulk_tasks`.

### Comments

- `get_task_comments`
- `get_threaded_replies`
- `create_task_comment`

### Tags

- `add_tag_to_task`
- `remove_tag_from_task`

### Task relationships

- `add_task_link`
- `remove_task_link`
- `add_dependency`
- `remove_dependency`

### Move and additional Lists

- `move_task_to_list`
- `add_task_to_list`

`add_task_to_list` requires the ClickUp **Tasks in Multiple Lists** ClickApp.

### Workspace hierarchy

- `get_workspace_hierarchy`
- `create_list_in_space`
- `create_list_in_folder`
- `get_list`
- `update_list`
- `get_folder`
- `create_folder`
- `update_folder`

### Members and assignees

- `get_workspace_members`
- `find_member_by_name`
- `resolve_assignees`

Member resolution returns candidates instead of choosing automatically when a name or email is ambiguous.

## Safe writes

Task deletion, Custom Field removals, and multi-item writes use a two-step flow:

1. Call the tool with `dry_run: true` to receive the exact preview and a short-lived confirmation token.
2. Enable the relevant environment flag and call again with the unchanged payload, `dry_run: false`, `confirm: true`, and the confirmation token.

Confirmation tokens expire after ten minutes, are tied to the exact operation payload, and can only be consumed once. Bulk operations use a maximum concurrency of three, have no implicit rollback, and report the result of every item.

`set_task_custom_fields` also defaults to preview mode. A single non-destructive field update may be executed with `dry_run: false` directly; removals and multi-field changes require the corresponding feature flag plus confirmation. Field applicability and value shapes are validated before any write begins.

## Errors and limits

Tool failures return a structured error with `code`, `message`, `retryable`, and optional `details`. Read requests retry transient `408`, `429`, and `5xx` failures up to three attempts. Writes are not automatically repeated after an uncertain failure.

The server observes ClickUp rate-limit headers. Search and bulk calls are intentionally bounded because ClickUp enforces limits per token and Workspace plan.

## Development

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use mocked ClickUp responses and in-memory MCP transports. CI must not use a production token. A final manual smoke test should use a sandbox Workspace and disposable Tasks.

## Troubleshooting

- `CONFIG_MISSING`: provide `CLICKUP_API_TOKEN` through the process environment.
- `WORKSPACE_REQUIRED`: configure `CLICKUP_DEFAULT_WORKSPACE_ID` or pass `workspace_id` to the tool.
- `WORKSPACE_NOT_AUTHORIZED`: reconnect with a token that can access the configured Workspace.
- `CLICKUP_HTTP_429`: reduce the search/bulk limits and wait for the reset time.
- `CONFIRMATION_MISMATCH`: repeat the preview after changing any delete or bulk payload.
- Additional-List errors: enable **Tasks in Multiple Lists** in the ClickUp Workspace.

## Architecture

`MCP stdio → tool registry and policies → domain tool modules → ClickUpClient → ClickUp API v2/v3`

The stdio transport starts immediately; ClickUp credentials and the optional default Workspace are validated lazily before the first tool operation. The API client centralizes timeouts, pagination primitives, rate limiting, retries, error normalization, and redacted telemetry. Hierarchy/member caches and confirmation state exist only in memory and are discarded when the process exits.
