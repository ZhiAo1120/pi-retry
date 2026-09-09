# pi-retry

A small Pi extension that adds a manual `/retry` command.

## Install

Install directly from GitHub:

```bash
pi install git:github.com/ZhiAo1120/pi-retry
```

Restart Pi, or run `/reload` in an existing session.

## Usage

After an assistant turn fails or is interrupted:

```text
/retry
```

The command only acts when the current branch contains a failed or interrupted
turn. It reports `Nothing to retry.` for a successful turn or an empty session.

## Recovery behavior

When the branch ends with a failed tool result, the extension keeps the current
conversation checkpoint and injects a hidden continuation request. The model is
asked to retry only the failed operation and avoid repeating successful tool
calls or completed side effects.

For provider-level failures without a failed tool-result tail, it navigates back
to the latest user request and resubmits that request. This fallback is needed
because Pi's public extension API does not expose the internal agent continuation
or generic tool-batch executor.

This is intentionally a best-effort implementation. It is not identical to
Oh My Pi's native `/retry`, which can replay an intact failed tool batch directly
without an additional model request. A model-mediated continuation cannot
provide the same byte-for-byte tool-argument or side-effect guarantees.

## Safety notes

- `/retry` refuses to run while Pi is busy.
- Successful tool results are not deliberately replayed by the extension.
- A failed operation may still have produced a partial external side effect;
  inspect the current state before retrying commands that are not idempotent.
- The extension has no runtime dependencies and uses only Pi's public extension
  methods.

## Development

```bash
npm test
npm run check
```

## License

MIT. See [LICENSE](LICENSE).
