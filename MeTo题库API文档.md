# MeTo 题库 API 与 OCS 集成说明

> 基于现有接口行为整理，并结合本仓库当前脚本接入方式补充。  
> 参考文件：`D:\学习通刷课\废2\tiku_test.html`。该文件现在仅作为接口行为参考，不再是脚本运行依赖。

---

## 当前脚本接入结论

- OCS 已支持 **直接请求远程 MeTo 题库**，不再依赖本地端口、本地 CORS 代理或额外启动服务。
- 当前接入同时支持：
  - 自动答题时搜题
  - “搜索结果”面板内手动单题搜题
  - “搜索结果”面板内按行批量搜题
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

## 默认认证配置

```json
{
  "tk_uid": "397265",
  "poolId": "2efc793b-661c-1760-d1ad-e51614113424",
  "pp": "9ffb0a9f",
  "user_id": ""
}
```

脚本中对应可配置项：

- `server`
- `tk_uid`
- `poolId`
- `pp`
- `user_id`

配置入口：`通用 -> 全局设置`

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
  "poolId": "2efc793b-661c-1760-d1ad-e51614113424",
  "token": "<dynamic-token>",
  "userId": "397265"
}
```

---

## 主要接口

### 1. 搜题：`POST /tiku/api/v1/queryProblems`

#### 单题模糊搜索

```json
{
  "poolId": "2efc793b-661c-1760-d1ad-e51614113424",
  "token": "<dynamic-token>",
  "userId": "397265",
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
  "poolId": "2efc793b-661c-1760-d1ad-e51614113424",
  "token": "<dynamic-token>",
  "userId": "397265",
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

- 单题搜索时，脚本会优先尝试精确收敛到与题干标准化后完全一致的结果。
- 若服务端返回 `hideAnswer: true`，脚本会继续请求 `queryProblemAnswer` 获取真实答案。

### 2. 获取真实答案：`POST /tiku/api/v1/queryProblemAnswer`

```json
{
  "poolId": "2efc793b-661c-1760-d1ad-e51614113424",
  "token": "<dynamic-token>",
  "userId": "397265",
  "problemId": 1993847
}
```

返回的 `answer` 通常仍是 JSON 字符串，脚本侧需要再做一次 `JSON.parse()` 或等价处理。

---

## OCS 当前实现细节

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
- 当前每个服务地址最多重试 `2` 次，之后自动切到备用域名。

### 时间校准

- 若服务端因时间误差拒绝请求，脚本会尝试从响应中提取服务端时间并更新本地 `time_error_rate`，随后自动重试。

### 手动搜题入口

- 入口位置：`通用 -> 搜索结果`
- 支持：
  - 单题搜索
  - 批量搜索（每行一题）
- 结果仍复用原有“搜索结果”展示组件，便于和自动答题结果统一查看。

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

- 推荐直接使用 `ocs.common.user.js`
- 如果使用普通版脚本，请确保具备以下 `@connect`：
  - `m.metst.cn`
  - `m.metost.com`

---

## 旧方案说明

旧的本地 `cors_proxy.js` / 本地端口方案现在仅保留为历史参考，当前 OCS 脚本运行时 **不再依赖** 该方案。
