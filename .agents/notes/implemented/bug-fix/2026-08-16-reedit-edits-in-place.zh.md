# Agent Note: Re-edit edits the user bubble in place

Status: implemented

[English](2026-08-16-reedit-edits-in-place.md) | 中文

## Problem

在一条已落定的用户消息上点击「编辑重发」时，编辑器会作为第二个面板追加到消息操作行下方，原气泡仍留在上方。屏幕上于是出现上下堆叠的两份相同文本，看起来像凭空多出一个输入框，而不是消息进入了编辑模式；消息较长时，编辑目标和编辑界面还相距甚远。

## Decision

重编辑现在是 `UserMessageNodeView` 的视图状态：非空的草稿种子把用户气泡原位替换成 `UserReeditEditor`，打开期间同时替换操作行。发送走 `rerunUserMessage` 动作（它把会话在该消息之前的已完成轮次处原地截断并重建——见[原地 rerun 决策](2026-08-16-rerun-truncates-and-rebuilds-in-place.md)）并关闭编辑器；取消不发送、直接关闭并恢复气泡。`UserRerunActions` 重新成为纯粹的操作行，只抛出 `onReedit`；编辑器组件及其样式仍与它同处 `UserRerunActions.tsx` / `UserRerunActions.module.css`。

## Alternatives considered

**编辑器保留在操作行下方，但打开时隐藏气泡。** 否决：编辑器仍然处在气泡几何之外，宽度和对齐可能与被编辑的消息漂移，开关时的布局跳动也依然存在。

**把文本载入主输入框进行编辑。** 否决：这样会丢失「正在修改哪条消息」的信息，与未发送的草稿冲突，且输入框的排队/steering 语义与重发一条已落定消息不同。

## Consequences

编辑目标与编辑界面是同一个元素，屏幕上任何时候只有一份文本。开关状态按消息节点保存，随视图销毁，无任何持久化。单元覆盖钉住：原样重发、在消息所在行内的原位替换、预填、修改后发送、空内容禁用发送、取消恢复气泡。
