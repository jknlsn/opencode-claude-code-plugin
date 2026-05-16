# @khalilgharbaoui/opencode-claude-code-plugin

An [opencode](https://opencode.ai) plugin that wraps the **Claude Code CLI** (`claude`) and routes model traffic through it instead of the Anthropic HTTP API. You get to use opencode's UI, agents, MCP, and permission system while authenticating and billing through whichever method `claude` is logged into (Pro/Max plan, Bedrock, Vertex, or API key).

> Maintained fork of [`unixfox/opencode-claude-code-plugin`](https://github.com/unixfox/opencode-claude-code-plugin). Published as `@khalilgharbaoui/opencode-claude-code-plugin` on npm.

---

## TL;DR

```bash
# 1. Make sure `claude` is installed and logged in
claude --version

# 2. Add this to your opencode.json
```

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"]
}
```

That's it. Restart opencode, pick a `claude-code` model, done.

The plugin self-registers the `claude-code` provider, all current Claude Code models (Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6/4.7) with reasoning variants (`low` / `medium` / `high` / `xhigh` / `max`), and sensible defaults for tool proxying. You don't need to write a `provider` block at all unless you want to override something.

---

## Prerequisites

- [opencode](https://opencode.ai) installed
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` on your `$PATH`)
- Node 18+ / Bun

## Install

### From npm (recommended)

```bash
npm install @khalilgharbaoui/opencode-claude-code-plugin
```

Then add it to `opencode.json` as shown in the TL;DR.

### Local development

```bash
git clone https://github.com/khalilgharbaoui/opencode-claude-code-plugin
cd opencode-claude-code-plugin
bun install
bun run build
```

In your `opencode.json`, point at the local build with a `file://` URL:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-claude-code-plugin"]
}
```

---

## Models

The plugin auto-registers the following. They appear in the model picker without any extra config.

| ID | Display name | Context | Output | Reasoning variants |
|---|---|---|---|---|
| `claude-haiku-4-5` | Claude Code Haiku 4.5 | 200k | 8,192 | – |
| `claude-sonnet-4-5` | Claude Code Sonnet 4.5 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-sonnet-4-6` | Claude Code Sonnet 4.6 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-5` | Claude Code Opus 4.5 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-6` | Claude Code Opus 4.6 | 1M | 16,384 | low/medium/high/xhigh/max |
| `claude-opus-4-7` | Claude Code Opus 4.7 | 1M | 16,384 | low/medium/high/xhigh/max |

Capabilities for every model: text + image input, text output, tool use, attachments. No temperature control, no PDF/audio/video, no interleaved streaming.

The model ID is passed straight through to `claude --model`, so anything Claude Code accepts works.

### Picking a variant

Variants set the underlying reasoning effort. They're regular opencode model variants — pick them in the model selector. If you'd previously declared variants in your project's `opencode.json`, they're merged on top of the defaults so nothing gets lost.

---

## Configuration

The minimum config is just the `plugin` entry above. Everything below is optional override that goes in a `provider.claude-code` block.

### Multiple Claude Code accounts

Declare account names once and the plugin expands them into separate opencode providers:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "accounts": ["personal", "work"]
      }
    }
  }
}
```

`default` is always implicit, so the config above creates:

| Provider ID | Display name | Claude config dir |
|---|---|---|
| `claude-code-default` | `Claude Code (Default)` | normal `~/.claude` |
| `claude-code-personal` | `Claude Code (Personal)` | `~/.claude-personal` |
| `claude-code-work` | `Claude Code (Work)` | `~/.claude-work` |

Non-default accounts use `CLAUDE_CONFIG_DIR` through a generated wrapper script, so auth/session state stays isolated per account. Shared capability files and folders are symlinked from `~/.claude` into each account dir when present:

```text
CLAUDE.md
settings.json
skills/
agents/
commands/
plugins/
```

Identity/session state is not shared.

Login each account once:

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-personal" claude auth login
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login
```

The account model IDs are internally suffixed, for example `claude-sonnet-4-6@work`, so long-lived Claude subprocess sessions do not collide across accounts. The generated wrapper strips the suffix before calling `claude --model`.

### Options reference

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "options": {
        "cliPath": "claude",
        "proxyTools": ["Bash", "Edit", "Write", "WebFetch"],
        "skipPermissions": true,
        "permissionMode": "default",
        "bridgeOpencodeMcp": true,
        "strictMcpConfig": false
      }
    }
  }
}
```

| Option | Type | Default | Description |
|---|---|---|---|
| `cliPath` | string | `process.env.CLAUDE_CLI_PATH ?? "claude"` | Path to the `claude` binary. |
| `accounts` | string[] | – | Optional account list. `default` is implicit. Expands into `Claude Code (Default)`, `Claude Code (Personal)`, etc. |
| `cwd` | string | `process.cwd()` | Working directory for the spawned CLI. Resolved **lazily per request**, so opencode's project switching works. |
| `skipPermissions` | boolean | `true` | Pass `--dangerously-skip-permissions` to `claude`. Ignored when `proxyTools` is set — the proxy handles permissions through opencode instead. |
| `permissionMode` | `acceptEdits` \| `auto` \| `bypassPermissions` \| `default` \| `dontAsk` \| `plan` | – | Forwarded to `claude --permission-mode`. |
| `proxyTools` | string[] | `["Bash", "Edit", "Write", "WebFetch"]` | Claude built-in tools to route through opencode's executor + permission UI. See [Selective tool proxy](#selective-tool-proxy). |
| `controlRequestBehavior` | `allow` \| `deny` | `allow` | Default response when `skipPermissions: false` and Claude sends a `can_use_tool` control request. |
| `controlRequestToolBehaviors` | `Record<string, "allow" \| "deny">` | – | Per-tool override for `can_use_tool`. Example: `{ "Bash": "deny", "Read": "allow" }`. |
| `controlRequestDenyMessage` | string | built-in message | Message returned to Claude on a deny. |
| `bridgeOpencodeMcp` | boolean | `true` | Auto-translate your opencode `mcp` block into Claude's `--mcp-config`. See [MCP bridge](#mcp-bridge). |
| `mcpConfig` | string \| string[] | – | Extra `--mcp-config` paths/JSON passed alongside the bridged config. |
| `strictMcpConfig` | boolean | `false` | Pass `--strict-mcp-config` so Claude loads **only** the configured servers and ignores `~/.claude/settings.json`. |
| `webSearch` | `"claude"` \| `"disabled"` \| `<tool>` | `"claude"` | Routing for Claude's built-in `WebSearch`. See [WebSearch routing](#websearch-routing). |
| `multiStepContinuation` | boolean | `true` | Append a system-prompt hint nudging Claude to chain tool calls within one turn instead of pausing between subtasks. Each opencode turn boundary requires the user to manually press "continue", so for multi-step tasks this reduces friction. Set `false` to disable. |
| `autoContinueIncompleteTurns` | boolean \| `"smart"` | `"smart"` | Smartly continue incomplete Claude CLI results inside the same opencode turn. Reduces manual "continue" presses when Claude ends after reasoning/tool activity without a useful final answer. Set `false` to disable. |
| `compactionModel` | string | `"claude-haiku-4-5"` | Model used when opencode invokes `/compact`. Override per-process via the `CLAUDE_CODE_COMPACTION_MODEL` env var (env wins over config). See [Compaction](#compaction). |

### Overriding model metadata

To rename a model, change a limit, or add a custom one:

```json
{
  "plugin": ["@khalilgharbaoui/opencode-claude-code-plugin"],
  "provider": {
    "claude-code": {
      "models": {
        "claude-sonnet-4-6": {
          "name": "Sonnet (custom)",
          "limit": { "context": 1000000, "output": 32768 }
        }
      }
    }
  }
}
```

Anything you supply is merged on top of the defaults; you don't need to redeclare every model.

---

## Selective tool proxy

This is the core feature.

By default, when Claude Code's CLI uses `Bash`, `Edit`, `Write`, etc., it executes them itself — bypassing opencode's permission UI, audit trail, and policy rules entirely. With `proxyTools`, you tell the plugin to disable Claude's built-in version of a tool and expose an equivalent through an in-process MCP server. Claude calls the MCP version, which blocks until opencode runs the tool through its own executor.

### Default proxied tools

| `proxyTools` value | Claude built-ins disabled | Proxy MCP tool exposed |
|---|---|---|
| `"Bash"` | `Bash` | `mcp__opencode_proxy__bash` |
| `"Edit"` | `Edit`, `MultiEdit` | `mcp__opencode_proxy__edit` |
| `"Write"` | `Write` | `mcp__opencode_proxy__write` |
| `"WebFetch"` | `WebFetch` | `mcp__opencode_proxy__webfetch` |

Only those four values are actually proxied; anything else you put in `proxyTools` is ignored. Proxying `Edit` also disables `MultiEdit` — opencode has no batched-edit equivalent, so Claude is forced to fan out into single `Edit` calls that each flow through the permission UI.

To turn off proxying entirely:

```json
"options": { "proxyTools": [] }
```

### What you get with proxying on

- opencode's **permission prompts** for every Bash/Edit/Write/WebFetch call (the default `claude --dangerously-skip-permissions` is NOT applied to proxied tools).
- opencode's **audit log** captures the calls.
- Per-tool **policy rules** in opencode apply.

### What you give up

- A small per-call latency hop through `127.0.0.1:<random>/mcp`.
- Batched-edit ergonomics: with `Edit` proxied, Claude can no longer use `MultiEdit`, so a refactor that would have been one tool call becomes N single `Edit` calls.

---

## WebSearch routing

Claude Code ships a built-in `WebSearch` tool. The `webSearch` option controls who actually executes those calls:

| `webSearch` value | Behavior | When to use |
|---|---|---|
| `"claude"` (default) | Claude CLI runs WebSearch internally via Anthropic. Zero setup, no extra cost, no API key. | Most users. |
| `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`) | Forward to that opencode-side tool with `executed:false`. Requires the corresponding MCP server to be configured in opencode (e.g. [exa-mcp-server](https://github.com/exa-labs/exa-mcp-server)). | You want a specific search backend (Exa, Tavily, Brave) and have the MCP wired up in opencode. |
| `"disabled"` | `WebSearch` is added to `--disallowedTools` so the model can't call it. | Compliance/security scenarios where outbound search isn't allowed. |

```json
"options": { "webSearch": "websearch_web_search_exa" }
```

**Trade-offs**

- Claude-side execution: free with your Claude usage, no API key, but no opencode visibility into queries/results, no caching/rate-limit hooks.
- opencode-side execution: choose any backend, queries flow through opencode's audit/policy/cache, but costs money (search APIs are paid) and adds a network hop.
- Some Claude-specific tool features stay on the built-in side (notably `MultiEdit` — see the note above).

---

## MCP bridge

If `bridgeOpencodeMcp` is true (the default), the plugin reads your opencode config's `mcp` block, translates it into Claude's MCP schema, writes it to a temp file, and passes that to `claude --mcp-config`. So whatever MCP servers you've already configured in opencode become available to Claude with no extra setup.

### Discovery order (highest to lowest priority)

1. `OPENCODE_CONFIG` env var (file path)
2. `OPENCODE_CONFIG_DIR` env var
3. Walk up from the current `cwd` looking for `opencode.jsonc`, `opencode.json`, `config.json`, or a `.opencode/` directory
4. Global `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`

Later sources override earlier ones **by server name**, so a project-level MCP server replaces a global one with the same id.

### Translation

| opencode `type` | Claude `type` |
|---|---|
| `local` | `stdio` |
| `remote` | `http` |

If you want to manage MCP servers only via `~/.claude/settings.json`, set `bridgeOpencodeMcp: false`.

To replace (rather than augment) bridged MCP with your own:

```json
"options": {
  "bridgeOpencodeMcp": false,
  "mcpConfig": "/path/to/your/mcp.json",
  "strictMcpConfig": true
}
```

---

## Sessions

Each chat keeps a long-lived `claude` subprocess so the model retains its native context across turns.

- **Session key**: `(cwd, model, tool-scope, opencode-session-id)`. The opencode session id comes from the `x-session-affinity` header opencode sets on third-party provider calls. Two chats in the same project on the same model run in **separate** CLI processes — they don't race. In account mode, model IDs are suffixed per account, so account sessions do not collide.
- **Same chat, multiple turns** → process reused, full Claude context retained.
- **New chat** → fresh process under the new session key.
- **Resumed chat after restart** → in-memory state is gone; a new process spawns and the conversation history is summarized and prepended.
- **Abort (Ctrl+C)** → stream closes, process stays alive for the next message in that chat.
- **Cap**: 16 active processes, LRU eviction.

---

## Plan mode

Set `permissionMode: "plan"` to forward `--permission-mode plan` to Claude. The plugin handles `ExitPlanMode` specially — instead of forwarding it as a tool call, it converts it to a confirmation prompt that flows through opencode normally.

---

## Compaction

When you run `/compact` in opencode, the plugin handles it on a short-lived dedicated Claude CLI spawn instead of routing it through your main conversation process. Three reasons:

1. **Cost.** The summarizer reads your entire transcript every time. Routing through a smaller model keeps `/compact` from burning your Opus budget.
2. **Latency.** Claude Haiku 4.5 hits ~150 tok/s with a hard 8k output cap, so compaction completes predictably (~30s for a long transcript).
3. **Cleanliness.** The compaction spawn skips MCP servers, the tool proxy, and the multi-step continuation hint. It's a one-shot text-out call; the rest is overhead.

The transcript itself is serialized rich: tool inputs and tool results are both included (each clipped at 10k chars), with oldest entries dropped first when the aggregate exceeds 180k chars. The summarizer sees actual tool activity rather than placeholders.

### Picking a different compaction model

| Source | How | Wins over |
|---|---|---|
| Env var (per-process) | `CLAUDE_CODE_COMPACTION_MODEL=claude-sonnet-4-6 opencode` | config, default |
| `opencode.json` (per-project) | `"compactionModel": "claude-sonnet-4-6"` under `provider.claude-code.options` | default |
| Default | `claude-haiku-4-5` | – |

Anything Claude Code's `--model` accepts works as a value.

---

## Extended thinking

The plugin forwards Claude's thinking blocks (`thinking_delta` stream events) to opencode as reasoning parts, so the "Thinking" row in the chat panel shows whenever the model uses extended thinking. This works across every Claude 4 family model the CLI supports.

What you see is a **summary** of the model's thinking, not the raw chain-of-thought. Anthropic [stopped exposing raw thinking on the Claude 4 family](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#summarized-thinking) and ships a server-generated digest instead. For Claude Opus 4.7 specifically, [thinking content is omitted from responses by default](https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default); the plugin opts back in by passing `--thinking-display summarized` on every spawn. Claude Code CLI 2.1.142+ is required for that flag to take effect; older CLIs skip it silently.

### Reasoning effort variants

Each model exposes `low` / `medium` / `high` / `xhigh` / `max` variants. Picking one injects the corresponding Claude CLI thinking keyword (e.g. `(ultrathink)` for `max`) into the user message. Compaction calls skip this injection so the full output budget goes to the summary.

### Env-var overrides

The plugin respects the standard Claude Code thinking env vars. If you set them in your shell, they pass through to the spawned process untouched.

| Env var | Effect |
|---|---|
| `CLAUDE_CODE_DISABLE_THINKING=1` | Disable thinking entirely. |
| `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` | Disable adaptive thinking only. |
| `CLAUDE_CODE_SHOW_THINKING_SUMMARIES=0` | Suppress summaries (the plugin sets this to `1` by default when unset). |

---

## Quirks worth knowing

- **Empty text blocks are dropped.** Claude sometimes opens a `content_block_start` for text but never sends a delta. The plugin no longer emits the empty block (which was triggering Anthropic 400s like `cache_control cannot be set for empty text blocks`).
- **Smart incomplete-turn continuation.** By default, the plugin keeps the current opencode stream open and feeds Claude CLI a small internal continuation message when Claude emits a `result` after reasoning/tool activity without a useful visible answer. It still stops normally on final-looking answers, questions, blockers, errors, aborts, or internal safety-budget exhaustion. Disable with `"autoContinueIncompleteTurns": false`.
- **`AskUserQuestion`** from the CLI is converted into plain text content rather than forwarded as a tool call.
- **Wire-inactivity watchdog.** Once the CLI has produced any content, the stream closes gracefully if stdout goes silent for 60 seconds without a `result` message arriving. Resets on every line received, so long mid-turn pauses (Sonnet between text-end and the next tool_use, for example) are tolerated. On a user-initiated abort, the watchdog shortens to 5 seconds.
- **Per-iteration usage.** When the CLI internally retries with tools, the plugin only counts the last iteration's usage so opencode's context accounting stays accurate.
- **Lazy `cwd`.** The working directory is re-resolved at every request, so opencode's project-aware behavior works without restarting the plugin.
- **Variants survive merge.** opencode recalculates variant lists after the plugin loads; the plugin re-injects defaults into runtime config so your variants don't disappear.

## Logging

Configure via `opencode.jsonc` (launch-method-independent) or env vars
(temporary override for a single process). The plugin has four orthogonal
knobs:

| Field | Values | Default | Effect |
|---|---|---|---|
| `file` | `true \| false` | `false` | Persist log entries to disk |
| `dir` | path string | `~/.local/share/opencode-claude-code/` | Custom file location |
| `mode` | `"silent" \| "debug"` | `"silent"` | TUI policy |
| `level` | `"debug" \| "info" \| "notice" \| "warn" \| "error"` | `"info"` | Minimum level to emit |

Rails-style threshold: anything below `level` is dropped before either
destination decides what to do. `mode: "silent"` routes DEBUG/INFO/NOTICE
to file only and lets WARN/ERROR bubble in the TUI (they always do).
`mode: "debug"` additionally echoes every emitted level to the TUI (which
opencode surfaces as warning bubbles).

**Recommended dev setup** — capture audit trail to disk, keep TUI quiet:

```jsonc
"@khalilgharbaoui/opencode-claude-code-plugin": {
  "logging": { "file": true }
}
```

**Full firehose for deep debugging** (every DEBUG stream event captured):

```jsonc
"logging": { "file": true, "level": "debug" }
```

**Live TUI noise** (everything echoes to opencode's stderr → warning bubbles):

```jsonc
"logging": { "file": true, "mode": "debug" }
```

### Env-var overrides

Set explicitly to override config for one process — useful for one-off
debugging without editing `opencode.jsonc`:

```bash
OPENCODE_CLAUDE_CODE_LOG_FILE=1 opencode          # file on
OPENCODE_CLAUDE_CODE_LOG_FILE=0 opencode          # file off (overrides config:true)
OPENCODE_CLAUDE_CODE_LOG_DIR=/tmp/cc opencode     # custom dir
OPENCODE_CLAUDE_CODE_LOG_LEVEL=debug opencode     # capture every level
DEBUG=opencode-claude-code opencode               # promote to mode:"debug"
```

Boolean env vars accept `1/true/on/yes` for on and `0/false/no/off` for
off; empty / unset falls through to config. Invalid `level` values fall
through to config.

### Default behavior (no config, no env)

Nothing persists; only WARN and ERROR bubble in the TUI. The plugin
doesn't accrete a log file on every user's disk by default — opt in when
you need to inspect auto-continue decisions, broker state, or other
plugin internals.

## Known limitations

- No streaming of tool inputs as they're being constructed (Anthropic's `input_json_delta`); the plugin emits them once complete.
- Raw chain-of-thought is not available. Claude 4 family models ship summarized thinking only. See [Extended thinking](#extended-thinking) for the full picture.
- Recommended Claude Code CLI: **2.1.142+**. Older CLIs work for everything else but skip the `--thinking-display` flag, so Claude Opus 4.7 turns may render empty Thinking rows. If something breaks after a Claude Code update, the CLI version is the first thing to check.

---

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit
bun run test        # tsx --test (unit suite)
bun run build       # tsup -> dist/
```

Source layout:

```
src/
  index.ts                       # opencode plugin entry, config + provider hooks
  models.ts                      # default models + variants
  accounts.ts                    # multi-account expansion (per-account CLAUDE_CONFIG_DIR + wrapper script)
  claude-code-language-model.ts  # AI-SDK provider that drives `claude`
  message-builder.ts             # AI-SDK prompt → Claude CLI user message
  tool-mapping.ts                # Claude tool name ↔ opencode tool name mapping; internal-tool skip list
  proxy-mcp.ts                   # in-process MCP server for proxied tools
  proxy-broker.ts                # pending proxy-call broker between proxy-mcp and opencode tool execution
  mcp-bridge.ts                  # opencode → Claude --mcp-config translator
  session-manager.ts             # LRU cache of CLI subprocesses
  cli-version.ts                 # detect Claude CLI version, gate optional flags
  runtime-status.ts              # runtime introspection of opencode (MCP status, tool registry)
  logger.ts                      # DEBUG=opencode-claude-code stderr logger
  tmp.ts                         # per-plugin temp directory helper
  cleanup-stale.ts               # remove legacy unscoped install from opencode's plugin cache
  types.ts                       # public option types
  opencode-types.ts              # mirrored opencode types
```

For runtime gotchas, the v1.15.0 audit waterline, and the release flow, see [`AGENTS.md`](./AGENTS.md).

## Publishing (maintainers)

```bash
npm version patch   # or minor/major — bumps package.json + creates the tag
git push origin master --follow-tags
```

The GitHub Actions workflow at `.github/workflows/publish.yml` runs `npm publish --access public` on tag push (requires `NPM_TOKEN` secret in the repo settings — use a classic automation token so 2FA isn't required at workflow time).

## License

MIT. See [LICENSE](./LICENSE).

Original work © `unixfox`. Fork modifications © Khalil Gharbaoui.
