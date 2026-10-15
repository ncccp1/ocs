# CLAUDE.md

This file provides guidance to Claude Code and other coding agents working in this repository.

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
- AI fallback lives in `utils/answerer.ts` (`searchAiQuestion`): only called when no wrapper returns a usable result (`isCredibleAnswer()`: non-placeholder answer and question similarity >= 0.5, or no question text / cache hit; and, when the options are plain text, the answer must match one of them via `isAnswerUsableForOptions()`), uses an OpenAI-compatible `chat/completions` endpoint (default DeepSeek `deepseek-flash`, `response_format: json_object`, thinking enabled by default via `aiThinking` with a 8192 `max_tokens`; an empty reply retries once with thinking disabled). When the model reports `confidence: low` (or gives no answer) and `aiWebSearch` is on, `nativeWebSearchAnswer()` uses the server-side `web_search_20250305` tool of DeepSeek's Anthropic-compatible endpoint (`/anthropic/v1/messages`; verified working, while Chat Completions and Responses ignore search), falling back to `searchWeb()` which scrapes Bing/DuckDuckGo snippets and asks again with them as context. Configured in `通用 -> 全局设置` (`aiEnable/aiBaseUrl/aiApiKey/aiModel/aiExtraBody`); the API key is user-entered and must never be hardcoded in source. For 超星章节测验 the answerer config is re-read (`getWorkOptions()`) every time the job is searched, and AI-only setups (no wrappers) are allowed via `isAiAnswererAvailable()`. Image URLs appended to titles/options (via `optimizationElementWithImage`) are sent as `image_url` parts when `aiUseImages` is on. AI requests go through `postJsonWithRetry()` (transient errors retried) and failures surface on the page via `notifyAiFailure()`; 超星 chapter/work flows call `reportUnfinishedQuestions()` after `doWork()`. AI is asked to return `option` letters; `finalizeAnswer()` maps them to the exact option texts (or keeps only letters when options are images, `imageChoiceMode`). AI results carry `extra_data.ai` and are cached at the same trust level as online banks (`source: 'ai'`). Cache titles are compared via `normalizeCacheTitle()` (ignores whitespace/punctuation/brackets/number and question-type prefix); never compare cache titles with `===`. Option lists whose letter and text sit on separate lines are merged by `mergeOptionLabelLines()`. Question cache entries have `source` (`standard` > `bank` = `ai`) and `scope` (course id from the page URL, see `getQuestionCacheScope()` in `common.ts`); `addQuestionCache` lets `standard` answers (read back from the page after submit/retake, stored as option text, not letters) overwrite older answers for the same title/scope, and `searchAnswerInCaches` only uses the highest-trust tier within the current course (unless `cacheCrossCourse` is on). Callers pass the option texts as the 3rd argument so cached answers that match none of the options (old fuzzy-search pollution) are dropped, purged and re-searched; panel logs are length-capped in `utils/logger.ts`.
- Option letters: only AI results carry `extra_data.option` (letters such as `B` / `AC`). The core resolver (`question.resolver.ts`) selects a **fresh** (non-cache) letter directly; cache results (`extra_data.cache`) are matched by content first and fall back to the stored letter. Caches store `option` next to `answer`, and `hasValidOptionLetter()` (`option-match.ts`) keeps such entries from being purged/ignored when the text matches no option.
- Search timing: `searchAnswerInWrappers()` queries all wrappers **in parallel**, each guarded by `searchWrapperWithDeadline()` (`AnswerWrapperHandlerConfig.timeout_seconds`; MeTo requests also have a per-attempt timeout). AI requests are **streamed** (`postChatStream()`, SSE merged back into the non-stream shape): `aiMaxWait` (default 600s) is the per-question budget covering thinking, web search and retries, and the idle watchdog only fires after data has been seen. `syncAiWaitConfig()` sets `AnswerWrapperHandlerConfig.extra_wait_seconds` so the core worker (`waitForRequested`) never gives up before the AI budget — keep these in sync when touching timeouts. `postJsonWithRetry()` treats `aiMaxWait` as one budget shared by all retries (each attempt is capped by `AI_ATTEMPT_MAX_MS`), and SSE keep-alive comments (sent while DeepSeek queues a request) do **not** count as activity, so a queued request is aborted by the idle watchdog instead of hanging for 600s. Worker scheduling (`worker.ts`): up to `thread` questions are searched concurrently, each search has its own deadline (`timeout_seconds + 10 + extra_wait_seconds`, enforced with `Promise.race` so a hung search never occupies a thread); a single serial resolver answers whichever question finished searching first. Auto-answer (`scene === 'auto'`) drops unrelated / answer-less bank results before they reach the resolvers (`isRelatedQuestion()` / `isCredibleAnswer()`), MeTo pre-filters unrelated results before fetching hidden answers, and hidden-answer placeholder text (“脚本版本过低…”) is cleared. AI has a circuit breaker (`recordAiServiceResult()`: 3 consecutive 5xx/429/timeouts pause AI for 60s, doubling up to 5min) so a busy DeepSeek does not cost 10 minutes per question.
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
- Manual search UI is embedded in `通用 -> 搜索结果`; selection auto-fill uses `utils/selection.ts` (`getSelectionTextWithImages`, keeps `<img>` as URLs) and only fills when the box is empty or still holds the last auto-filled value; it shows a "推荐选择" built by `utils/option-match.ts` (shared with the 超星 video-quiz answerer).
- For 超星章节测试, “达到阈值自动提交” and “未达到阈值自动保存” are both expected behaviors.

## Workflow

- After changing userscript behavior, run `pnpm build`.
- If answerer/search behavior changes, update these docs together:
  - `README.md`
  - `CHANGELOG.md`
  - `CHANGELOG_CURRENT.md`
  - `CHANGELOG_SIMPLIFIED.md`
  - `MeTo题库API文档.md`
  - `CLAUDE.md`

## Testing

There is no full automated test suite. Validation is mainly:

- `pnpm tsc`
- `pnpm build`
- manual browser verification on the relevant platform pages
