# Context Space

Context Space is a local-first work context system. It captures relevant Lark
context through `lark-cli`, stores canonical records as Markdown, and presents
Todo, people, knowledge, timeline, and Loop-readiness views in a local Web UI.

## V1 safety boundary

- The server binds to `127.0.0.1` by default.
- Lark integration uses `lark-cli --as user` and a strict read-only allowlist.
- Credentials and access tokens are never written to Markdown.
- `workspace/` is ignored by Git because it can contain private work context.
- Loop is visible but disabled. V1 has no execution endpoint, scheduler, or
  external-action button.

## Requirements

- Node.js 20 or newer
- `lark-cli` installed and authenticated for optional Lark synchronization

## Development

```bash
npm install
npm run dev
```

The Web UI runs at `http://127.0.0.1:5173` and proxies API calls to
`http://127.0.0.1:4318`.

## Workspace

The canonical workspace defaults to `./workspace`. Override it without moving
the application:

```bash
CONTEXT_SPACE_ROOT=/absolute/private/path npm run dev
```

On first start, Context Space creates the versioned directory layout and
baseline Markdown configuration idempotently. Search/backlink state is rebuilt
from Markdown and can be discarded at any time.

## Lark synchronization

Use the Settings page or:

```bash
curl -X POST http://127.0.0.1:4318/api/sync/lark
```

The adapter retrieves group mentions, P2P messages, calendar events, tasks,
and current-user identity. It uses checkpoints and overlap windows to avoid
gaps, and records per-source failures without mutating Lark.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use temporary workspaces and injected Lark command runners. They do not
access a real Lark account.
