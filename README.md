# 南城派网课助手

> 基于开源项目 OCSJS 二次开发的网课辅助脚本项目。  
> 上游项目：`https://github.com/ocsjs/ocsjs`

## 项目说明

南城派网课助手面向常见高校网课场景，支持超星学习通、智慧树、智慧职教、职教云、中国大学 MOOC 等平台的学习与答题辅助。

当前仓库已经完成对 `MeTo` 题库的直接接入，脚本运行时可直接请求远程题库，不再依赖本地端口、本地代理或额外启动服务。

## 当前二开重点

- 直接接入 `MeTo` 题库，支持主备域名切换、重试、隐藏答案二阶段查询
- 新增独立“搜题日志”，和系统日志分开查看
- 在“搜索结果”面板内支持手动单题搜题、按行批量搜题
- 超星章节测试在未达到自动提交阈值时，仍会自动保存
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
