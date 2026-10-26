# pi-retry

A small Pi extension that adds a manual `/retry` command without rewinding the
conversation or resubmitting the original user request.

## Install

Requires Node.js 22.19 or newer. Tested against Pi 1.0.0.

```bash
pi install git:github.com/ZhiAo1120/pi-retry
```

Restart Pi, or run `/reload` in an existing session.

For local development, load the checkout directly instead of maintaining a copy
in Pi's extensions directory:

```bash
pi install /path/to/pi-retry
```

Pi loads local packages without copying them. Use only one installation source:
remove any previous git/npm installation and move an old
`~/.pi/agent/extensions/manual-retry.ts` outside the extensions directory before
reloading. Keep a backup if that file contains local changes.

## Usage

After an assistant turn fails or is interrupted:

```text
/retry
```

The command requires an idle, UI-enabled session (TUI or a UI-capable RPC client).
It accepts only the optional `--force` and `--deep` flags and does nothing in
non-UI contexts.
Pi's built-in automatic retry handles transient provider errors; this extension
adds no retry loop or backoff policy and does not change global retry settings.

## Repeated-failure protection

A retry cannot fix an unchanged bad request, invalid credentials, exhausted quota
or broken provider routing. Repeating it indefinitely only adds latency and cost.

- After a manual retry returns the same failure without progress, another plain
  `/retry` is blocked. An already-dispatched checkpoint is also not sent twice.
- During a run started by `/retry`, the first repeated provider error stops Pi's
  native retry scheduler. Even if the errors keep changing, at most **three failed
  provider requests without progress** are allowed in that manual attempt. A lower
  native retry limit still applies. SDK-internal transport retries are outside
  this budget; keep `retry.provider.maxRetries` at Pi's default of `0`.
- The original error is preserved. Warnings suggest checking rate limits/quota,
  credentials, request/provider routing, or the failed operation. Stopping uses
  Pi's normal abort path; the TUI restores queued user input to the editor.
- The guard reads only the active session branch, so it survives `/reload` and
  session restoration, recognizes older retry markers, and does not leak across
  independent branches. New user requests, successful tool progress, changed
  errors/arguments or selecting a different model can permit a fresh attempt.
  Diagnostic shell output alone does not clear the guard; user cancellation is
  not counted as a provider failure.
- Only an error fingerprint and selected model are added to retry metadata, not
  raw errors or tool arguments. Fingerprints ignore request/trace IDs and tool-call
  IDs, but retain operation/argument differences.

After correcting the external cause, explicitly request one new bounded attempt:

```text
/retry --force
```

`--force` bypasses the previous-attempt guard, **not** the busy-session check or
in-run failure budget. Do not repeatedly force an unchanged failure. Ordinary
user prompts and runs started by other extensions retain their native retry
policy; this extension does not impose a global rate limiter.

Tool execution is still model-mediated: the continuation asks the model to stop
and explain a repeated tool failure. The hard in-run guard applies to provider
errors, not to arbitrary tools repeatedly invoked within one successful model
conversation.

## Request repair

A retry normally resends the same history, so a pooled upstream that answers with a
different resource can reject it forever: history items minted by the previous
resource no longer resolve. For the run a manual retry starts, the extension repairs
the outgoing Responses API payload:

- The default mode drops only the optional `id` of complete message and tool items.
  Message bodies, tool pairs, `call_id`, `encrypted_content` and every reasoning item
  survive, so the model keeps its cross-turn thinking state.
- `--deep` additionally drops historical reasoning items. That is lossy: the model
  loses its earlier thinking, and the prompt cache prefix changes. Use it only when
  the upstream keeps rejecting the request with the default mode.
- Repair never touches ordinary requests, chat-completions payloads, or runs started
  by anything other than `/retry`, and it disarms when the run settles. A removed
  count is reported once per repaired attempt.

When the upstream reports the resource-attribution rejection, the repeat-failure
warning names `--deep` instead of generic routing advice.

## Recovery behavior

The extension examines the latest assistant response and any following tool
results on the active branch:

- An assistant response ending with `error` or `aborted` can be resumed.
- A failed result in the latest tool batch can be resumed, even if another result
  in that batch succeeded.
- A successful final response or a new user request prevents older failures from
  being retried. The terminal stop reason is authoritative, not stale error text.
- Diagnostic shell output such as `!git status`, system messages and session
  metadata do not hide an otherwise retryable failure.
- Requests originating from other extensions can be resumed without requiring a
  user-message ancestor.

For both provider and tool failures, `/retry` keeps the current checkpoint and
injects a hidden continuation message. The model is asked to inspect the current
state for partial side effects and retry only the failed or unfinished operation.
The extension never navigates the session tree, replays the original user prompt,
or directly re-executes a tool.

This is intentionally **best effort**, not an exactly-once execution guarantee.
Pi's public extension API does not expose a manual retry executor. A
model-mediated continuation cannot guarantee identical tool arguments or prevent
every duplicate external side effect. Inspect the state before retrying operations
that are not idempotent, especially when an interrupted operation may already have
succeeded externally.

## Development

```bash
npm ci
npm test
npm run check
npm pack --dry-run
```

Tests use Node's built-in test runner, including an offline Pi loader/session
check with a local fake model and no real tool execution. `check` runs strict
TypeScript checking of the extension against Pi's official declarations, rather
than merely importing stripped TypeScript. Dependency declaration internals are
excluded with `skipLibCheck`; the extension itself is typechecked. Pi and
TypeScript are development-only dependencies; the extension has no runtime
dependencies.

## License

MIT. See [LICENSE](LICENSE).
