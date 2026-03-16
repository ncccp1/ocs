# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

OCS (Online Course Script) 网课刷课脚本，基于 pnpm monorepo，支持超星学习通、知到智慧树、职教云、智慧职教、中国大学MOOC 等平台的自动学习/答题/考试。构建产物为 Tampermonkey/Violentmonkey 用户脚本（.user.js）。

## Build Commands

```bash
# 前置：先编译 utils 包（首次或 utils 变更时）
cd packages/utils && npx tsc

# 完整构建（清理 → tsc → vite build → 生成 .user.js）
pnpm build

# 开发模式（监听 packages/scripts 变更自动重建）
pnpm dev

# 仅 TypeScript 编译（lint + tsc core & utils）
pnpm tsc

# 代码检查与格式化
pnpm lint
pnpm format
```

构建需要 `.env` 文件存在于 `packages/core/` 和 `packages/scripts/` 中：
```
VITE_BUILD_PATH=../../dist
```

构建输出到 `dist/` 目录：
- `ocs.user.js` — 正式版（代码内嵌）
- `ocs.dev.user.js` — 开发版（通过 file:/// 引用本地 index.js，改代码后 build + 刷新页面即可）
- `ocs.common.user.js` — 全域名通用版（@connect 包含 *）

## Architecture

三层 monorepo 结构，依赖方向：`utils` ← `core` ← `scripts`

### packages/core (@ocsjs/core)
核心引擎层。Vite 打包为 UMD 格式，全局变量名 `OCS`。
- **answer-wrapper/** — 题库请求构建、响应解析、答案匹配（精确/相似度）
- **worker/** — `OCSWorker` 多线程答题器，管理搜题→填写→提交的完整流程
- **core/utils/** — DOM 选择器封装、HTTP 请求（fetch/GM_xmlhttpRequest）、字符串处理

### packages/scripts (@ocsjs/scripts)
平台适配层。通过 vite alias `@ocsjs/core` 直接引用 core 源码编译。
- **projects/** — 每个平台一个文件：
  - `cx.ts` (超星学习通) — 视频播放、章节测试、作业考试、阅读
  - `zhs.ts` (知到智慧树) — 共享课/智慧课程/AI课程/融合课程
  - `icourse.ts` (中国大学MOOC) — 视频、PPT、讨论、测验
  - `icve.ts` (智慧职教) — 视频、文档、作业考试
  - `zjy.ts` (职教云) — 同上优化
  - `common.ts` — 全局设置、题库配置、在线搜题、答题结果展示
  - `background.ts` — 日志、版本检测、PC软件通讯、请求监控
- **utils/** — `study.ts`(视频播放控制)、`work.ts`(答题工作流)、`configs.ts`(配置管理)
- **entry.js / entry.dev.js / entry.common.js** — 三个入口文件，初始化并调用 `start()`

### packages/utils (@ocsjs/utils)
构建工具包，编译目标 ES5。核心函数 `createUserScript()` 用于将 entry + metadata 打包为 .user.js 文件。

### scripts/ (Gulp 任务)
- `build-core.js` — 完整构建流水线：cleanOutput → buildPackages(tsc+vite) → createUserJs
- `dev-core.js` — 开发监听模式
- `tsc.js` — TypeScript 编译（utils → core）

## Key Patterns

- 所有平台脚本继承 `Project` 基类（来自 easy-us 框架），通过 `domains` 匹配 URL，`scripts` 定义功能模块
- 答题流程：`AnswerWrapperParser` 解析题库配置 → 并行请求多个题库 → `OCSWorker` 调度搜题/填写 → 支持暂停/继续/重做
- UI 框架基于 `easy-us`，通过 `$store` 持久化配置，`start()` 函数启动所有匹配当前域名的 Project
- 用户脚本 metadata（@match, @grant, @connect 等）在 `build-core.js` 的 `createOptions()` 中动态生成

## Workflow

- 每次完成代码修改后，必须重新执行 `pnpm build` 构建，确保产物是最新的
- 开发版用户使用 `ocs.dev.user.js` 时，改代码后需要 `pnpm build` + 刷新页面
- 每次更新功能或修复 bug 后，必须同步更新自述文件（README）记录变更内容

## Code Style

- ESLint: standard + prettier，行宽 120
- Prettier: 单引号、Tab 缩进、无尾逗号、有分号
- TypeScript strict mode，core/scripts 目标 ES6，utils 目标 ES5
你要能够正确准确的调用系统的所有工具
