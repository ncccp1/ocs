# AGENTS.md

This file provides guidance to Codex and other coding agents working in this repository.

## Project Overview

`南城派网课助手` is a `pnpm` monorepo for browser userscripts.

This project is a secondary development based on the upstream open-source project `OCSJS`:

- upstream: `https://github.com/ocsjs/ocsjs`
- current repo: `https://github.com/ncccp1/ocs`

It supports platforms such as 超星学习通、智慧树、智慧职教、职教云、中国大学 MOOC and focuses on automated study, quiz answering and exam assistance.

## Build Commands

```bash
pnpm build
pnpm dev
pnpm tsc
pnpm lint
pnpm format
pnpm mock:answerer
pnpm mock:answerer:smoke
```

Build output goes to `dist/`:

- `nanchengpai.user.js`: standard bundled userscript
- `nanchengpai.dev.user.js`: development userscript
- `nanchengpai.common.user.js`: all-domain userscript with broader `@connect`

`pnpm build` also writes `release/` (committed, served from `raw.githubusercontent.com/ncccp1/ocs/main/release/`): `nanchengpai[.common].user.js` plus a header-only `.meta.js`. The userscript headers carry `@updateURL` (the `.meta.js`) and `@downloadURL`, and `background.ts` `update` script polls the same `.meta.js` every 6h to show an in-page prompt. To publish: bump `package.json` version, `pnpm build`, commit `release/`, push. The `(dev)` build has no update URL.

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
- `utils/answerer.ts`: unified script-side search entry, including direct `MeTo` integration
- `utils/logger.ts`: panel log abstraction with separate namespaces for system logs and search logs

## Key Patterns

- Prefer `searchAnswerInWrappers()` / `searchQuestionsInWrappers()` from `packages/scripts/src/utils/answerer.ts` for script-side search flows.
- `MeTo` is configured in `通用 -> 全局设置`; it is a direct remote integration and does not require a localhost proxy or extra local service.
- Search-related diagnostics go to `后台 -> 搜题日志`; system-level messages stay in the normal console panel.
- Manual search UI is embedded in `通用 -> 搜索结果`.
- For 超星章节测试, “达到阈值自动提交” and “未达到阈值自动保存” are both expected behaviors.
- For 超星章节测试/作业页, “错题回填重答” is opt-in via `通用 -> 全局设置`; it may force-submit a first pass, cache extracted correct answers locally, then try an automatic retake. Work “查看详情” answer pages should also auto-cache extracted correct answers. If a question misses the answerer but already has a page-selected answer, keep that original answer and only random-fill truly blank questions. Selection-state detection must avoid page-wide answer-state classes and should prefer per-option state (`checked`, `aria-checked`, visible selected markers) to avoid toggling correct cached choices into their inverse.
- After a normal 超星章节测验 submit, the script should also try to open answer/analysis view and cache submitted correct answers locally without triggering retake.
- Local question caches are intended to be long-lived, unlimited in count, and user-manageable via `通用 -> 拓展应用 -> 题库缓存` export/import/delete/clear controls.

## Workflow

- After changing userscript behavior, run `pnpm build`.
- If answerer/search behavior changes, update these docs together:
  - `README.md`
  - `CHANGELOG.md`
  - `CHANGELOG_CURRENT.md`
  - `CHANGELOG_SIMPLIFIED.md`
  - `MeTo题库API文档.md`
  - `AGENTS.md`

## Testing

There is no full automated test suite. Validation is mainly:

- `pnpm tsc`
- `pnpm build`
- manual browser verification on the relevant platform pages
