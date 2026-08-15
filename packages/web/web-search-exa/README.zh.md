# @deepseek-ai/dsh-web-search-exa

[English](README.md) | 中文

由 [Exa](https://exa.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.md)（`ctx.web`）。它调用 Exa 的 `POST /search` 端点并请求高亮摘要内容，把扁平 `results[]` 映射为 seam 规范化的 `WebSearchResult`。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-llm-deepseek` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `apiKey` | （未设置） | 字面量 Exa API 密钥。建议使用 `apiKeyEnv`，避免密钥进入配置文件。 |
| `apiKeyEnv` | `EXA_API_KEY` | 每次搜索时通过 credentials 服务解析的凭据引用；解析不到时回退到启动环境中同名环境变量。 |
| `baseURL` | `https://api.exa.ai` | 端点基址；追加 `/search`。无法解析时提供方不可用。 |
| `searchType` | `auto` | 以 Exa `type` 发送的检索模式：`auto`（由 Exa 决定）、`keyword` 或 `neural`。 |
| `numResults` | （未设置） | 请求不含 `maxResults` 时使用的默认结果数。未设置时不发送默认值。必须是正整数。 |
| `highlightsPerResult` | `1` | 每个结果请求的 highlight 句子数（Exa `highlightsPerUrl`）。必须是正整数。 |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

以上所有字段也可以在 Web UI 设置页编辑（插件 → 插件配置 → Exa 网页搜索卡片），提交的改动对下一次搜索即生效，无需重启。卡片通过 credentials 域写入 API 密钥，而不是写入设置文档。密钥解析优先级：字面量 `apiKey`（配置或设置页）优先，其次是 `apiKeyEnv` 命名的 credentials 服务条目，最后是启动环境的 `$EXA_API_KEY`。三层都没有密钥时，搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败。

## 映射

Exa 返回扁平 `results[]`，不返回生成答案，因此省略 `content`。每项结果映射为 `WebSearchSource`：`url` ← `url`、`title` ← `title`、`snippet` ← 第一个非空的 `highlights[]` 条目（没有高亮摘要的结果缺少可移植的 snippet，会被丢弃）、`publishedAt` ← `publishedDate`。请求的 `maxResults` 优先于已配置的默认 `numResults`，并作为 Exa `numResults` 发送，以优化成本和延迟；最终上限由 seam 强制执行。提供方失败（HTTP 错误、网络失败、响应体无法解析或结构不符）以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题、首条 highlight 与发布日期，或将确切的错误消息 `Exa search aborted`、`Exa search request failed: <error>` 和 `Exa returned an unprocessable response body: <error>` 置于消费方的错误包装层内；生成答案与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **没有非空白高亮摘要的结果会被整个丢弃**：没有可映射的可移植 snippet，因此返回源可能少于请求数量。
- **只公开 `searchType`／`numResults`／`highlightsPerResult`**：Exa 的其他控制项（livecrawl、category、域名／日期过滤条件、全文内容）等待提供方无关的 Service Definition 字段（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)）。
- **按错误形状分类中止**：只有 `DOMException` 且名为 `AbortError` 时才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
