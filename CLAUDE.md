# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents when working in this repository.

## Project Overview

OCS (Online Course Script) is a `pnpm` monorepo for browser userscripts. It supports platforms such as 超星学习通、智慧树、智慧职教、职教云、中国大学 MOOC and focuses on automated study, quiz answering and exam assistance.

## Build Commands

```bash
# Full build: core/utils/scripts compile + bundle + generate .user.js files
pnpm build

# Development watch mode
pnpm dev

# TypeScript + lint pipeline
pnpm tsc

# Lint / format
pnpm lint
pnpm format

# Local mock answerer service
pnpm mock:answerer
```

Build output goes to `dist/`:
- `ocs.user.js`: standard bundled userscript
- `ocs.dev.user.js`: development userscript
- `ocs.common.user.js`: all-domain userscript with broader `@connect`

## Architecture

Dependency flow: `packages/utils` -> `packages/core` -> `packages/scripts`

### `packages/core`
- Core answerer / worker engine
- `answer-wrapper/`: request building, response parsing, answer matching
- `worker/`: `OCSWorker` orchestration for search -> fill -> submit

### `packages/scripts`
- Platform adapters and end-user UI
- `projects/common.ts`: global settings, answerer configuration, online/manual search, search result panel
- `projects/background.ts`: background utilities, request inspection, system logs, search logs
- `projects/cx.ts`, `zhs.ts`, `icourse.ts`, `icve.ts`, `zjy.ts`: platform-specific study/quiz flows
- `utils/answerer.ts`: unified script-side search entry, including:
  - direct `MeTo` integration
  - retry + primary/backup server fallback
  - hidden-answer second-stage fetch
  - exact-title narrowing for single-question search
  - shared auto-search and manual-search pipeline
- `utils/logger.ts`: panel log abstraction with separate namespaces for system logs and search logs

### `packages/utils`
- Build-time helpers
- `createUserScript()` packages entry files into distributable `.user.js` artifacts

## Key Patterns

- Prefer `searchAnswerInWrappers()` / `searchQuestionsInWrappers()` from `packages/scripts/src/utils/answerer.ts` for script-side search flows instead of calling `defaultAnswerWrapperHandler()` directly.
- `MeTo` is configured in `通用 -> 全局设置`; it is a direct remote integration and does not require a localhost proxy or extra local service.
- Search-related diagnostics should go to `后台 -> 搜题日志`; system-level messages stay in the normal console panel.
- Manual search UI is embedded in `通用 -> 搜索结果`, not split into a separate standalone tool.
- For 超星章节测试, “达到阈值自动提交” and “未达到阈值自动保存” are both part of the expected upload flow.

## Workflow

- After changing userscript behavior, run `pnpm build`.
- If answerer/search behavior changes, update these docs together:
  - `README.md`
  - `CHANGELOG.md`
  - `CHANGELOG_CURRENT.md`
  - `CHANGELOG_SIMPLIFIED.md`
  - `MeTo题库API文档.md`
  - `CLAUDE.md`
- If a change needs cross-origin access, verify whether `ocs.common.user.js` or extra `@connect` permissions are required.

## Code Style

- ESLint: `standard` + `prettier`
- Prettier: single quotes, tabs, semicolons, no trailing commas
- TypeScript: strict mode
- Keep patches focused; do not mix unrelated experimental UI/workflow changes into feature commits

## Testing

There is no full automated test suite. Validation is mainly:
- `pnpm tsc`
- `pnpm build`
- manual browser verification on the relevant platform pages

For answerer-related work, `pnpm mock:answerer` can be used for local smoke testing.
