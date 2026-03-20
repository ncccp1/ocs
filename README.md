<div align="center">

<div style="padding:8px;border-radius:100%;background:white;width:124px;height:124px">
<img src="https://cdn.ocsjs.com/resources/img/logo.png" width="124" height="124">
</div>

# OCS 网课助手

> OCS (Online Course Script) 网课辅助脚本，帮助大学生处理常见网课学习、作业与考试场景

![GitHub Repo stars](https://img.shields.io/github/stars/ocsjs/ocsjs)
![npm](https://img.shields.io/npm/v/ocsjs?color=red)
![NPM](https://img.shields.io/npm/l/ocsjs)
![今日安装](https://img.shields.io/badge/dynamic/json?color=orange&label=今日安装&query=$.data.today_install&url=https://scriptcat.org/api/v2/scripts/367)
![总共安装](https://img.shields.io/badge/dynamic/json?color=red&label=总共安装&query=$.data.total_install&url=https://scriptcat.org/api/v2/scripts/367)

</div>

## 官网及教程
- 文档站：<https://docs.ocsjs.com>
- 全域名通用版说明：<https://docs.ocsjs.com/docs/other/api#全域名通用版本>

## 本次更新
> 对比上一版 `4.12.16`，本次待发布更新主要聚焦题库接入、搜题日志与答题页保存兜底。

- 新增 `MeTo` 题库直连接入，脚本可直接请求远程题库，不再依赖本地端口、本地代理或额外启动服务。
- 新增 `server / tk_uid / poolId / pp / user_id` 认证配置，支持使用 `user_id + pp` 重新计算 `poolId`。
- 新增独立“搜题日志”分类和面板，请求、响应、重试、报错详情与系统日志分离。
- “搜索结果”面板内新增手动搜题入口，支持单题搜索和按行批量搜索。
- `MeTo` 搜题链路新增重试、主备域名切换、隐藏答案二阶段查询和精确题干收敛。
- 超星章节测试在未达到自动提交阈值时，会自动保存而不是答完后不做处理。

## MeTo 配置
- 配置入口：`通用 -> 全局设置`
- 默认认证：
  - `tk_uid`: `397265`
  - `poolId`: `2efc793b-661c-1760-d1ad-e51614113424`
  - `pp`: `9ffb0a9f`
- 可选填写 `user_id`，再通过界面按钮重算 `poolId`
- 推荐使用 `ocs.common.user.js`，或手动添加：
  - `@connect m.metst.cn`
  - `@connect m.metost.com`

## 搜题入口
- 自动答题：各平台答题流程统一走新的搜题管线
- 手动搜题：`通用 -> 搜索结果`
- 日志查看：`后台 -> 搜题日志`
- 批量搜题：每行输入一题即可一次查询多题

## 开发命令
```bash
pnpm tsc
pnpm build
pnpm mock:answerer
```
