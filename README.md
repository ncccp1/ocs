# 南城派网课助手

> 基于开源项目 OCSJS 二次开发的网课辅助脚本项目。  
> 上游项目：`https://github.com/ocsjs/ocsjs`

## 项目说明

南城派网课助手面向常见高校网课场景，支持超星学习通、智慧树、智慧职教、职教云、中国大学 MOOC 等平台的学习与答题辅助。

当前仓库已经完成对 `MeTo` 题库的直接接入，脚本运行时可直接请求远程题库，不再依赖本地端口、本地代理或额外启动服务。

## 当前二开重点

- 直接接入 `MeTo` 题库，支持主备域名切换、重试、隐藏答案二阶段查询
- 新增独立“搜题日志”，和系统日志分开查看
- 新增“AI 兜底答题”（通用 -> 全局设置）：所有题库都搜不到答案时调用 OpenAI 兼容接口（默认 DeepSeek `deepseek-flash`，JSON 结构化返回）；需自行填写 API Key，答案带 `AI` 标签并写入题库缓存（与在线题库同级）
- AI 请求失败会自动重试并在页面提示；答题结束后会汇总提示没有答出的题号
- AI 答题会同时返回所选选项字母；选项是图片（公式、电路图）时按 A/B/C/D 发送图片并只返回字母
- AI 答题默认深度思考；AI 不确定时会自动联网搜索后再作答（优先使用 DeepSeek 原生联网搜索，不可用时抓取 Bing / DuckDuckGo）
- 题库缓存按课程区分，并按“标准答案 > 在线题库 = AI”使用；重做取得标准答案后会自动覆盖旧的错误答案，缓存窗口支持搜索与按来源筛选
- 超星“视频内题目”支持题库/AI 答题，与视频内容强相关的题目 AI 会标记“信息不足”并给出最可能的答案
- AI 答题支持图片题：题干/选项中的图片会一并发送给 AI（需模型支持图片输入，DeepSeek `deepseek-flash` 支持）
- 划词搜索支持带图片的题目（图片链接随文本填入并可预览，AI 搜题会一并发送图片）；仅在搜索框为空时自动填入，清空后重新填入
- 手动搜题会解析题目里的选项，直接给出“推荐选择”（挑选最相似的结果并配对到选项）
- 在“搜索结果”面板内支持手动单题搜题、按行批量搜题
- 超星章节测试在未达到自动提交阈值时，仍会自动保存
- 超星章节测试/作业页新增“错题回填重答”：未全部完成时可随机补答、提交后读取正确答案写入本地缓存，并尝试自动重做；手动进入“查看详情”答案页也会自动缓存正确答案
- 超星章节测验正常提交完成后，也会尝试打开答案/解析视图并缓存正确答案到本地题库
- 错题回填重答时仅以真实勾选状态判断选项是否已选中，避免把详情页答案样式误当成已选而反选
- 未命中题库但页面已有作答时会保留原答案提交，只对真正空题随机补答；命中超星回填缓存时优先按缓存答案覆盖页面选项
- 超星作业/考试页接入“答题完成后”完成率设置：达到阈值自动提交，未达到阈值自动保存
- 作业详情页缓存正确答案时会剔除分数、AI 讲解等详情文字
- 题库缓存改为长期保存、不限制条数，并支持单独导出/导入备份
- 支持自定义 `server / tk_uid / poolId / pp / user_id`，并保留默认认证配置

## 构建与产物

```bash
pnpm install
pnpm build
```

构建后会生成：

- `dist/nanchengpai.user.js`
- `dist/nanchengpai.dev.user.js`
- `dist/nanchengpai.common.user.js`

其中 `nanchengpai.common.user.js` 为全域名通用版，适合需要更宽松 `@connect` 权限的场景。

## 安装与自动更新

构建时还会同步生成 `release/` 目录，提交到 `main` 分支后即为发布，首次安装请直接点击下面的链接，之后脚本会自动检查更新：

- 标准版：https://raw.githubusercontent.com/ncccp1/ocs/main/release/nanchengpai.user.js
- 全域名通用版：https://raw.githubusercontent.com/ncccp1/ocs/main/release/nanchengpai.common.user.js

自动更新由两部分组成：

- 脚本头中的 `@updateURL` / `@downloadURL`，由 Tampermonkey、Scriptcat 等脚本管理器按自身周期检查并更新
- 脚本内置的更新提示：每 6 小时读取一次 `release/*.meta.js`，有新版本时弹窗提示，可在“后台 -> 更新模块”中关闭

发布新版本时：修改 `package.json` 的 `version`，执行 `pnpm build`，然后把 `release/` 一并提交并推送。调试版 `dist/nanchengpai.dev.user.js` 不会检查更新。

## 开发命令

```bash
pnpm dev
pnpm tsc
pnpm build
pnpm mock:answerer
pnpm mock:answerer:smoke
```

## 相关文档

- `MeTo题库API文档.md`
- `CLAUDE.md`
- `CHANGELOG.md`
- `CHANGELOG_CURRENT.md`
- `CHANGELOG_SIMPLIFIED.md`

## 仓库地址

- 项目仓库：`https://github.com/ncccp1/ocs`
- 问题反馈：`https://github.com/ncccp1/ocs/issues`
