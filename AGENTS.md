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

`pnpm build` also writes `release/` (committed, served from `raw.githubusercontent.com/ncccp1/ocs/main/release/`): `nanchengpai[.common].user.js` plus a header-only `.meta.js`. The userscript headers carry `@updateURL` (the `.meta.js`) and `@downloadURL`, and `background.ts` `update` script polls the same `.meta.js` every 1h (also on a timer in long-lived tabs) to show an in-page prompt. To publish: bump `package.json` version, `pnpm build`, commit `release/`, push. The `(dev)` build has no update URL.

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
- Option letters: only AI results carry `extra_data.option` (letters such as `B` / `AC`). The core resolver (`question.resolver.ts`) selects a **fresh** (non-cache) letter directly; cache results (`extra_data.cache`) are matched by content first and fall back to the stored letter. Caches store `option` next to `answer`, and `hasValidOptionLetter()` (`option-match.ts`) keeps such entries from being purged/ignored when the text matches no option.
- Search timing: `searchAnswerInWrappers()` queries all wrappers **in parallel**, each guarded by `searchWrapperWithDeadline()` (`AnswerWrapperHandlerConfig.timeout_seconds`; MeTo requests also have a per-attempt timeout). AI requests are **streamed** (`postChatStream()`, SSE merged back into the non-stream shape): `aiMaxWait` (default 600s) is the per-question budget covering thinking, web search and retries, and the idle watchdog only fires after data has been seen. `syncAiWaitConfig()` sets `AnswerWrapperHandlerConfig.extra_wait_seconds` so the core worker (`waitForRequested`) never gives up before the AI budget — keep these in sync when touching timeouts.
- MeTo has **no built-in account**: `DEFAULT_METO_AUTH_CONFIG` credentials are empty on purpose and must not be hardcoded again; users fill `tk_uid/poolId` (tutorial: `showMetoGuide()` in `common.ts` and `MeTo题库API文档.md`).
- Question cache lookups go through an in-memory index (`getQuestionCacheIndex()` in `common.ts`); call `invalidateQuestionCacheIndex()` after any direct write to `localQuestionCaches`.
- Debug mode (`utils/debug.ts`, `utils/snapshot.ts`): switch and dry-run live in `后台 -> 开发者调试` (`background.dev.debugEnabled/dryRun`). Use `$debug.log(module, msg, detail)` to record decisions (no-op when off), call `skipInDryRun(action)` right before any submit/save/auto-jump, and register state worth exporting with `registerSnapshotCollector(name, fn)`. The page snapshot export asks every iframe (through GM store keys `ncp.snapshot.*`) for its own document and redacts enc/token/uid-style params; output is a JSON file with all frames, redacted settings and recent logs.
- Floating control bar: every auto-answer flow (homework, exam, chapter test) calls `attachWorkFloatingBar(worker)` (`utils/work.ts`); pause state is shared by the bar and the panel button through `setWorkPaused()/isWorkPaused()`. The bar is mounted on the top document so it also works from the chapter-test iframe.
- 超星考试 auto retake (`chapterTest-autoRetake`) is **work-only by default**; exams need `chapterTest-autoRetake-exam` plus a confirmation dialog (`confirmExamRetake()`), because an exam can usually be submitted only once.
- Release flow: bump `package.json` version, `pnpm build` (writes `dist/` and the committed `release/` consumed by `@updateURL`/`@downloadURL` and the in-script update prompt), commit `release/`, push (see `scripts/release.sh`).
- Window shell (`utils/workbench.ts`, styles in `assets/less|css/style.*` under "工作台外壳"): easy-us still creates the window/panels, `installWorkbench()` (top frame only, started from the hidden background script `workbench`) adds the title bar, left nav (grouped by script namespace, see `NAV_GROUP_OF_NAMESPACE`), status bar and the 44px collapsed dot on top of the existing `container-element`. The original `header-element` is hidden by CSS but must keep existing (easy-us rebuilds it on every panel switch; its mutations are used to refresh the nav). Icons are inline SVG (`utils/icons.ts`) because the UI lives in a closed Shadow DOM.
- Task state (`utils/task-state.ts`): every runner reports what it is doing through `setTaskState()` / `trackMediaProgress()` / `attachMediaToTask()` / `updateTaskFromResults()` / `beginBusy()`; the dot, title bar, overview page and status bar only read it. State lives in the tab store (`ncp.task-state`) so iframes (chapter test, video) and the top window share it, and it goes stale after `TASK_STALE_MS` without a heartbeat. Window buttons talk back through `sendTaskCommand()` / `onTaskCommand()` / `registerMediaControl()`; player auto-resume handlers must check `isUserPaused()`.
- Local UI preview: `pnpm build && pnpm ui:preview` serves `scripts/ui-preview/index.html` (stubbed GM API, no userscript manager needed) at http://127.0.0.1:5175/index.html; drive the window from the browser console with `OCS.setTaskState(...)`.
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
