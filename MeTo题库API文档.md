# MeTo 题库 API 与南城派网课助手集成说明

> 本项目基于开源项目 `OCSJS` 二次开发：`https://github.com/ocsjs/ocsjs`  
> 当前仓库：`https://github.com/ncccp1/ocs`  
> 参考文件：`D:\学习通刷课\废2\tiku_test.html`，该文件仅作为接口行为参考，不再是脚本运行依赖。

---

## 当前脚本接入结论

- 南城派网课助手已支持 **直接请求远程 MeTo 题库**
- 不再依赖本地端口、本地 CORS 代理或额外启动服务
- 当前接入同时支持：
  - 自动答题时搜题
  - “搜索结果”面板内手动单题搜题
  - “搜索结果”面板内按行批量搜题
  - 超星章节测试/作业页“错题回填重答”从提交结果提取到的答案会写入本地题库缓存，后续重答优先命中缓存；手动进入“查看详情”答案页时也会自动缓存
  - 超星章节测验正常提交完成后，会尝试打开答案/解析视图并缓存正确答案
  - 错题回填重答会先清理真实已选项再按缓存答案重选，避免提交详情页答案样式触发反选
  - 未命中题库但页面已有作答时保留原选项提交，仅对真正空题随机补答
  - 从作业详情页提取正确答案时会剔除分数、AI 讲解等非答案文字
  - 本地题库缓存长期保存、不限制条数，支持在 `通用 -> 拓展应用 -> 题库缓存` 中导出/导入备份
- 当前脚本已内置：
  - 请求重试
  - 主备域名切换
  - 隐藏答案二阶段查询
  - 单题精确题干收敛
  - 独立搜题日志

---

## 服务地址

| 用途 | 地址 |
|------|------|
| 主服务 | `https://m.metst.cn` |
| 备用服务 | `https://m.metost.com` |
| AI 接口 | `https://v.metst.cn` |
| 文档 | `https://doc.metst.cn` |

---

## 认证配置（需要自行填写）

> 自 4.12.46 起，脚本**不再内置任何默认的 MeTo 账号**，需要填写你自己的认证信息，否则 MeTo 题库无法使用。
> 之前版本里写死的默认账号不再提供，也不建议继续使用他人的账号。

脚本中对应可配置项（`通用 -> 全局设置`）：

| 配置项 | 说明 |
|------|------|
| `server` | 服务地址，默认 `https://m.metst.cn`，可切换为 `https://m.metost.com` |
| `tk_uid` | 请求体中的 `userId` |
| `poolId` | 请求体中的 `poolId`；留空时可用 `user_id + pp` 自动计算 |
| `pp` | 密钥种子，可选，仅用于重新计算 `poolId` |
| `user_id` | 平台用户 ID，可选，仅用于重新计算 `poolId` |

在设置页点击“**MeTo 认证获取教程**”也可以查看下面的步骤。

### 如何获取 tk_uid 和 poolId

> 说明：MeTo 官方文档站（`doc.metst.cn`）目前没有公开说明这些值的获取方式，下面的方法是根据本文档中记录的请求格式整理的：
> 搜题请求的请求体里包含 `userId`（即 `tk_uid`）和 `poolId`。

1. 安装并登录 MeTo 官方脚本。登录使用邮箱，登录邮件里的链接需要在“已安装脚本的浏览器”中打开。
2. 打开任意网课答题页面，让 MeTo 官方脚本执行一次搜题。
3. 按 `F12` 打开开发者工具，切换到“网络（Network）”，在筛选框输入 `queryProblems`。
4. 点击这条请求，在“载荷（Payload）/请求负载”中可以看到 JSON：
   - `userId` 的值 → 填入 `tk_uid`
   - `poolId` 的值 → 填入 `poolId`
5. 回到 `通用 -> 全局设置` 填入并保存即可，下一次搜题生效。

`pp` 与 `user_id` 只有在拿不到 `poolId` 时才需要，可点击“重算 MeTo poolId”自动计算。

> ⚠️ 这些值等同于你的账号凭证：不要分享给他人，也不要把包含它们的“导出全部设置”文件发给别人。

---

## poolId 计算

当未直接填写 `poolId` 时，可使用 `user_id + pp` 重新计算：

```javascript
const hash = md5(md5(user_id) + pp);
const poolId =
  hash.slice(0, 8) +
  '-' +
  hash.slice(8, 12) +
  '-' +
  hash.slice(12, 16) +
  '-' +
  hash.slice(16, 20) +
  '-' +
  hash.slice(20, 32);
```

---

## Token 生成

```javascript
function generateToken(timeErrorRate = 0) {
  let timePart = (Math.floor((Date.now() - timeErrorRate) / 1000) % 10000).toString();
  while (timePart.length < 4) timePart = '0' + timePart;

  const chars = '0123456789abcdef';
  let hex = '';
  for (let i = 0; i < 32; i++) hex += chars[Math.floor(Math.random() * 16)];

  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    timePart +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}
```

格式：`xxxxxxxx-xxxx-TTTT-xxxx-xxxxxxxxxxxx`

---

## 通用请求体

所有接口均为 `POST`，`Content-Type: application/json; charset=utf-8`

```json
{
  "poolId": "<your-pool-id>",
  "token": "<dynamic-token>",
  "userId": "<your-tk-uid>"
}
```

---

## 主要接口

### 1. 搜题：`POST /tiku/api/v1/queryProblems`

#### 单题模糊搜索

```json
{
  "poolId": "<your-pool-id>",
  "token": "<dynamic-token>",
  "userId": "<your-tk-uid>",
  "querry": {
    "operator": "contains",
    "argument1": "problemText",
    "argument2": "（）是人生观的核心。"
  }
}
```

#### 批量精确搜索

```json
{
  "poolId": "<your-pool-id>",
  "token": "<dynamic-token>",
  "userId": "<your-tk-uid>",
  "querry": {
    "operator": "mulit",
    "argument1": "1",
    "argument2": "2",
    "problems": [
      { "operator": "==", "argument1": "problemText", "argument2": "第一题题干" },
      { "operator": "==", "argument1": "problemText", "argument2": "第二题题干" }
    ]
  }
}
```

#### 说明

- 单题搜索时，脚本会优先尝试精确收敛到与题干标准化后完全一致的结果
- 若服务端返回 `hideAnswer: true`，脚本会继续请求 `queryProblemAnswer` 获取真实答案

### 2. 获取真实答案：`POST /tiku/api/v1/queryProblemAnswer`

```json
{
  "poolId": "<your-pool-id>",
  "token": "<dynamic-token>",
  "userId": "<your-tk-uid>",
  "problemId": 1993847
}
```

返回的 `answer` 通常仍是 JSON 字符串，脚本侧需要再做一次 `JSON.parse()` 或等价处理。

---

## 当前实现细节

### 重试与主备切换

- 默认服务器顺序：
  1. 用户当前配置的 `server`
  2. 另一个内置域名（`m.metst.cn` / `m.metost.com`）
- 遇到以下情况会自动重试：
  - `408`
  - `409`
  - `425`
  - `429`
  - `5xx`
  - `52x`
  - `200` 但响应体为空
- 当前每个服务地址最多重试 `2` 次，之后自动切到备用域名

### 时间校准

- 若服务端因时间误差拒绝请求，脚本会尝试从响应中提取服务端时间并更新本地 `time_error_rate`，随后自动重试

### 手动搜题入口

- 入口位置：`通用 -> 搜索结果`
- 支持：
  - 单题搜索
  - 批量搜索（每行一题）
- 结果复用原有“搜索结果”展示组件，便于和自动答题结果统一查看

### 搜题日志入口

- 查看位置：`后台 -> 搜题日志`
- 日志内容包含：
  - 请求地址
  - 脱敏后的请求体
  - 响应状态码
  - 服务端响应内容
  - 重试 / 切换备用域名过程

---

## 跨域权限说明

- 推荐直接使用 `nanchengpai.common.user.js`
- 如果使用普通版脚本，请确保具备以下 `@connect`：
  - `m.metst.cn`
  - `m.metost.com`
  - `raw.githubusercontent.com`

---

## 旧方案说明

旧的本地 `cors_proxy.js` / 本地端口方案现在仅保留为历史参考，当前脚本运行时 **不再依赖** 该方案。


