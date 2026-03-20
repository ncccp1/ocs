## [Unreleased] (2026-03-20)

> 对比上一版 `4.12.16`，本次待发布更新主要聚焦 MeTo 题库直连、搜题日志拆分与答题页保存兜底。

### Features

* **script:** 新增 `MeTo` 题库直连接入，支持自定义 `server / tk_uid / poolId / pp / user_id`，并支持通过 `user_id + pp` 重新计算 `poolId`
* **script:** 新增独立“搜题日志”面板，与系统日志分离，可单独查看请求、响应、重试与报错详情
* **script:** 在“搜索结果”面板内新增手动搜题入口，支持单题搜索和按行批量搜索
* **script:** 统一超星、智慧树、中国大学 MOOC、智慧职教、职教云等平台的脚本侧搜题入口，复用新的搜题管线

### Performance Improvements

* **script:** `MeTo` 搜题新增请求重试、主备域名切换、时间校准、精确题干收敛与隐藏答案二阶段补全

### Bug Fixes

* **cx:** 超星章节测试未达到自动提交阈值时，改为自动保存，避免答题完成后既不提交也不保存

## [4.12.16](https://github.com/ocsjs/ocsjs/compare/4.12.15...4.12.16) (2026-03-06)


### Bug Fixes

* **script:** 修复智慧课程AI伴学的视频无法检测，以及掌握度只有一题的情况无法答题的BUG ([8ff88f2](https://github.com/ocsjs/ocsjs/commit/8ff88f2ddf2a16852082b5ca7d84575d5215bb6a))
* **script:** 优化 eslint 报错 ([036644f](https://github.com/ocsjs/ocsjs/commit/036644fc351cbdba3cca55655200bf1cd421dc92))


