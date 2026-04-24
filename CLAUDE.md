# AGENTS.md

Instructions for AI coding agents (Claude Code, Copilot, Cursor, etc.) working on **OpenTentacles**.

---

## Project at a glance

- **What it is:** A pluggable framework that brings the GitHub Copilot agent into chat apps. v1 ships a Discord DM channel; the plugin contract is designed so new channels (Telegram next) drop into `src/channels/<name>/` without core changes.
- **Tech stack:** TypeScript + Bun (bun-first). Do not introduce Node-only shims — prefer `Bun.file`, `Bun.env`, `bun:sqlite`, `bun test`, `Bun.Glob`.
- **Entry point:** `src/index.ts` → loads config → discovers channels via `src/registry.ts` → starts them with a shared `CopilotOrchestrator` (per-user session cache).
- **Plugin contract:** `src/core/types.ts` — each channel folder default-exports a `Channel` implementation.

## Scripts

```bash
bun install
bun run dev         # hot-reload dev
bun run start       # run once
bun test            # unit tests (bun:test)
bun run typecheck   # tsc --noEmit
```

**Before proposing a change is "done"**, run `bun run typecheck && bun test`. Both must pass.

## Code conventions

- TypeScript `strict` + `noUncheckedIndexedAccess` — narrow array access, don't assert with `!` unless the invariant is obvious.
- ESM only. Use `.ts` extensions in relative imports (`./foo.ts`) — the tsconfig enables `allowImportingTsExtensions`.
- No `any`. Use `unknown` at boundaries and narrow.
- Prefer injecting dependencies (see `CopilotOrchestrator` taking `CopilotClientLike`) so modules are unit-testable without live network.
- Secrets via `.env` (`Bun.env.*`), non-secrets via `config.toml` loaded through `src/core/config.ts`.

---

# Commit Workflow: Clean Commit

**All commits in this repo MUST follow the Clean Commit workflow** ([wgtechlabs/clean-commit](https://github.com/wgtechlabs/clean-commit), v1.1.0).

> Clean Code deserves Clean Commit.

## Format

```
<emoji> <type>: <description>
```

With optional scope:
```
<emoji> <type> (<scope>): <description>
```

With breaking-change marker (only valid for `new`, `update`, `remove`, `security`):
```
<emoji> <type>!: <description>
<emoji> <type>! (<scope>): <description>
```

## Mandatory rules

1. **Emoji** — exact emoji for each type (see table below).
2. **Type** — lowercase, one of the 9 defined types.
3. **Colon** — required after type (or after scope if present).
4. **Space** — single space after the colon.
5. **Description:**
   - Present tense (`add`, not `added`; `fix`, not `fixed`)
   - Lowercase first letter
   - No trailing period
   - ≤ 72 characters total (including emoji and type)
   - Clear and concise

## Optional elements

- **Scope** — lowercase, single word preferred, hyphenated if needed, in parentheses with a space before the opening paren (`🔧 update (api): …`).
- **Breaking change `!`** — placed immediately after the type, before scope or colon. Only valid on `new`, `update`, `remove`, `security`. Include `BREAKING CHANGE:` in the body for detail.

## The 9 types

| Emoji | Type | When to use |
|-------|------|-------------|
| 📦 | `new` | Adding new features, files, dependencies, capabilities. |
| 🔧 | `update` | Modifying/refactoring existing code; non-security bug fixes; perf; UX. |
| 🗑️ | `remove` | Deleting deprecated code, unused deps, obsolete features, commented-out code. |
| 🔒 | `security` | Security patches, CVEs, auth/authz bugs, XSS/CSRF/SQLi fixes, security-driven dep updates. |
| ⚙️ | `setup` | One-time config: build, CI/CD, linters, Docker, project scaffolding. |
| ☕ | `chore` | Ongoing maintenance: non-security dep bumps, formatting, reorg, housekeeping. |
| 🧪 | `test` | Adding/updating/fixing tests, coverage, test utilities. |
| 📖 | `docs` | READMEs, guides, API docs, inline comments, tutorials, typo fixes in docs. |
| 🚀 | `release` | Version releases, release candidates, hotfixes, package publishes. |

## Decision tree

```
Is this a version release/tag? ─────────── yes → 🚀 release
Is this a security fix/patch? ──────────── yes → 🔒 security
Is this ONLY documentation? ────────────── yes → 📖 docs
Is this ONLY test-related? ─────────────── yes → 🧪 test
Is this project config/tooling/CI? ─────── yes → ⚙️ setup
Are you removing code/features/deps? ───── yes → 🗑️ remove
Are you adding NEW functionality? ──────── yes → 📦 new
Are you changing EXISTING code? ────────── yes → 🔧 update
Is this maintenance/deps/cleanup? ──────── yes → ☕ chore
```

## Good vs bad examples

✅ Good:
```
📦 new: user authentication system
🔧 update (api): improve error handling
🗑️ remove: deprecated payment gateway
🔒 security (auth): fix jwt token validation bypass
⚙️ setup (ci): configure github actions for testing
☕ chore (deps): bump react from 17.0.2 to 18.2.0
🧪 test: add unit tests for authentication service
📖 docs: update installation instructions
🚀 release: version 1.0.0
📦 new!: completely redesign authentication system
```

❌ Bad:
```
new: user authentication          (missing emoji)
📦 New: authentication            (capitalized type)
📦 new: Authentication.           (capitalized description, has period)
📦 new:authentication             (missing space after colon)
📦 new: Added auth                (past tense)
📦 new(api): feature              (missing space before scope)
⚙️ setup!: add ci pipeline        (! not allowed on setup/chore/test/docs/release)
```

## Rules of thumb

- **One logical change per commit.** If you're tempted to combine types, split the commit.
- **`new` vs `update`:** Is the capability new, or does it already exist and you're changing how it works? New → `new`. Exists → `update`.
- **`setup` vs `chore`:** First-time configuration → `setup`. Ongoing maintenance → `chore`.
- **Bug fixes:** Security → `security`. Everything else → `update` (you're updating broken code to work).
- **Breaking changes:** Add `!` after the type; also add `BREAKING CHANGE:` in the body.

## Agent responsibilities

When asked to create a commit:

1. **Inspect the diff first** (`git status`, `git diff --cached`, `git log -5 --oneline`) before picking a type.
2. **Pick exactly one type** using the decision tree. If the diff spans categories, flag it and propose splitting before committing.
3. **Format strictly** — the rules above are not suggestions; malformed commits will be rejected.
4. **Never commit unless explicitly asked.** Do not auto-commit after edits.
5. **Do not skip hooks** (`--no-verify`, `--no-gpg-sign`) unless explicitly instructed.
6. **Do not amend** — always create a new commit unless the user asks for `--amend`.
7. **Body is optional** — use it for the "why", context, BREAKING CHANGE notes, or issue references. Keep the subject line focused on the "what".

---

## Credits

Commit workflow: [Clean Commit](https://github.com/wgtechlabs/clean-commit) by [@wgtechlabs](https://github.com/wgtechlabs), MIT licensed. Full specification: [SPECIFICATION.md](https://github.com/wgtechlabs/clean-commit/blob/main/SPECIFICATION.md).
