# Agent Note: General-assistant persona and ask-only-when-decisive constraint

Status: implemented

[English](2026-08-16-general-assistant-persona-ask-constraint.md) | 中文

## Problem

一次产品会话暴露了本改动针对的意图识别失败：用户说「帮我翻译 <一句话>」（翻译这句话），agent 却认定「内容一定是一份没发出来的文档」，两次追问内容、Glob 工作目录找 `*.docx`/`*.pdf` 文件，直到用户反复发火才考虑到那句话本身就是待处理内容。两个提示词层面的原因叠加：所有产品 persona 都以「You are a coding agent」开头，把每个请求都框成「仓库里的工作、内容在文件里」；而 `ask_user_question` 的描述只写了「缺信息就问」、没有反向约束，于是提问零成本，第一个错误假设从不根据用户的后续回复修正。

## Decision

`standard`、`code`、`cordis` 三个 agent preset 以及 `web-app`、`headless` 两个 bundle patch 的 persona 现在以「You are a general-purpose assistant powered by the {{model}} model — especially strong at coding, but ready to help with any task」开头，并新增第二句：把用户的整条消息当作请求本身——其中的文字可能就是要翻译、总结或改写的内容，优先采用这种解读，而不是默认内容在某个用户从未给过的文件里。

`ask_user_question` 的描述补上了缺失的「什么时候不要用」一半：只有当答案会改变下一步行动时才问；不问对话中已经存在的信息；先检查用户消息本身是否就是待处理内容。

## Alternatives considered

**新增一个专门的「意图识别」提示词段落。** 否决：意图识别不是一个可以下令执行的动作，它是若干具体行为约束的涌现结果——先推断再提问、重读最新用户消息、给请求里的每个 token 分配角色。写一段「理解用户意图」是无法执行的空话。

**只修观察到失败的 web 部署的 persona。** 否决：coding-only 的框架在每个产品 persona 里一字不差，同样的失败从每个入口都能复现；统一的一句话让修复对称、措辞单一来源。

**同时改写 `examples/*` 的「coding assistant」 persona。** 本次不改：那些是带录制回放夹具的演示叶子，不是产品 persona；它们的用途就是演示如何自写 persona，且快照里嵌着录制文本。

## Consequences

每个产品入口的系统提示词变化两句，ask 工具的 schema 描述变长——两者都走常规的 keyless golden 更新（`apps/web` fresh-round-trip 系统提示词、`examples/acp-agent` tool-schemas）。本改动约束的是提示词而非模型：从不考虑自指解读的模型仍然可能失败，但现在规则把这种解读列为首选，并且让反复澄清提问从默认路径变成违规。
