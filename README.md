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
| `CLICKUP_TOOL_PROFILE` | no | `full` | Tool catalog: all 40 tools with `full`, or the compact common-workflow catalog with `core`. |
| `CLICKUP_ENABLE_DESTRUCTIVE` | no | `false` | Allows confirmed Task/comment deletion, task merging, and Custom Field value removal. |
| `CLICKUP_ENABLE_BULK_WRITES` | no | `false` | Allows confirmed bulk task writes and multi-field Custom Field writes. |
| `CLICKUP_BULK_MAX_ITEMS` | no | `25` | Per-call bulk limit; maximum allowed value is 100. |
| `CLICKUP_SEARCH_MAX_PAGES` | no | `5` | Default Task pages scanned; maximum allowed value is 20. |
| `CLICKUP_REQUEST_TIMEOUT_MS` | no | `15000` | Timeout for each upstream API request. |

`.env.example` documents the same values, but the server intentionally does not load `.env` files itself.

## Tools

The default `full` profile exposes exactly 40 tools in P0. Set
`CLICKUP_TOOL_PROFILE=core` to expose only the common search, Task, comment, Tag,
hierarchy, and assignee-resolution workflow. The compact profile contains 14 tools and
reduces the tool-discovery payload without changing any tool's request or response shape.

### Search

- `search_workspace`
- `filter_tasks`

`search_workspace` performs a bounded API sweep over Tasks, Spaces, Folders, and Lists. It does not search Docs. A truncated result includes a continuation cursor and scan counters; it never walks an unbounded Workspace implicitly.

`filter_tasks` composes tags, statuses, assignees, List/Folder/Space scopes, due and completion date ranges, task types, subtask inclusion, and sorting in one server-side request. Arrays are OR within one dimension and dimensions are ANDed. Like the other searches, each call is bounded by `limit` and `max_pages` and returns a continuation cursor when truncated.

### Task management

- `create_task`
- `get_task`
- `update_task`
- `set_task_custom_fields`
- `get_custom_fields`
- `delete_task`
- `merge_tasks`
- `create_bulk_tasks`
- `update_bulk_tasks`

`create_task` and `update_task` accept either `description` for plain text or
`markdown_description` for formatted Markdown, but not both. The server maps
`markdown_description` to ClickUp's upstream `markdown_content` field. The same input
contract applies to items in `create_bulk_tasks` and `update_bulk_tasks`.

`time_estimate` is expressed in minutes; the server converts it to the milliseconds ClickUp
expects. `update_task` clears an estimate when it receives an explicit `null`.

`priority` accepts either a ClickUp label (`urgent`, `high`, `normal`, `low`) or the matching
wire number (`1` through `4`). The scale is fixed at those four values in every Workspace.
`update_task` clears a priority when it receives an explicit `null`.

`create_task` and `update_task` accept `task_type` as either a `custom_item_id` such as `7` or
a display name such as `Bug`, matched case-insensitively against the Workspace task types plus
the built-in `Task` and `Milestone`. An unmatched or ambiguous name fails with
`TASK_TYPE_NOT_FOUND` or `TASK_TYPE_AMBIGUOUS`, lists the candidates, and writes nothing.
`update_task` resets a task to the built-in `Task` type when it receives an explicit `null`.
Resolution needs a Workspace, so pass `workspace_id` when `CLICKUP_DEFAULT_WORKSPACE_ID` is
unset; a bulk call resolves the type list once for every item.

`get_custom_fields` accepts a Task, List, Folder, Space, or Workspace location and returns
field IDs, types, applicability metadata, and dropdown/label option UUIDs. Task-scoped
discovery automatically resolves the home List and excludes fields that do not apply to
the Task's custom task type.

### Attachments

- `request_attachment_upload`
- `attach_task_file`
- `download_task_attachment`

Uploads use a two-step flow: stage an explicit local file path, a base64 payload, or an
HTTPS URL (optionally with an `Authorization` header),
then pass the short-lived `upload_id` to `attach_task_file`. Staged payloads expire after
ten minutes, are consumed only after a successful multipart upload, and are limited to
25 MiB to keep MCP messages and process memory bounded. Downloads can return ClickUp's
signed URL or write the file to an explicit local path; existing files are preserved unless
`overwrite: true` is supplied.

### Comments

- `get_task_comments`
- `get_threaded_replies`
- `create_comment`
- `create_task_comment`
- `update_comment`
- `delete_comment`

`create_comment` targets a Task, List, or Chat view, can create a threaded reply with
`reply_to_id`, and supports user or group assignment. `create_task_comment` remains as a
compatibility tool for its original Task-only contract.

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
- `remove_task_from_list`

`add_task_to_list` and `remove_task_from_list` require the ClickUp **Tasks in Multiple Lists** ClickApp. The removal tool refuses to remove a Task from its home List.

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

Task/comment deletion, task merging, Custom Field removals, and multi-item writes use a two-step flow:

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
