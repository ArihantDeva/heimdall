# Heimdall adapters

`heimdall init --harness <name>` wires Heimdall into your coding agent. Run it
after `npm i -g @arihantdeva/heimdall`. One command per harness; all idempotent.

| Harness | Command | What gets installed |
|---|---|---|
| Pi | `heimdall init --harness pi` | `~/.heimdall/adapters/pi/` — extension install instructions + prompt snippet |
| Claude Code | `heimdall init --harness claude-code` | `~/.claude/settings.json` PostToolUse hook (edit-log sync) + `~/.claude/HEIMDALL.md` snippet |
| Codex CLI | `heimdall init --harness codex` | `~/AGENTS.md` search/insert snippet |
| Cursor | `heimdall init --harness cursor` | `~/.cursor/rules/heimdall.mdc` rules file |
| Windsurf | `heimdall init --harness windsurf` | `~/.windsurf/rules/heimdall.md` rules file |
| All | `heimdall init --harness all` | everything above |

## Pi (reference adapter)

Pi gets the deepest integration — native extensions live in `extensions/` of
this package (`kb-tools.ts` exposes `kb_search` / `kb_insert` / `kb_sync` as
agent tools; `kb-autosync.ts` hooks tool results; `kb-orient.ts` injects
prior work into session start). Copy them into `~/.pi/agent/extensions/`:

```
cp "$(npm root -g)/@arihantdeva/heimdall/extensions/"kb-*.ts ~/.pi/agent/extensions/
```

The adapter README at `~/.heimdall/adapters/pi/README.md` repeats this.

## Smoke checks

Every adapter has a passing test in `tests/adapters.test.mjs` that runs
`heimdall init --harness X` against a temp HOME and asserts the config files
land correctly.
