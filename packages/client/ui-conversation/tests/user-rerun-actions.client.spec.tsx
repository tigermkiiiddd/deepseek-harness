// @vitest-environment jsdom
/**
 * UserRerunActions gestures and the in-place re-edit: the re-run button
 * re-sends the message verbatim, the re-edit button swaps the user bubble for
 * an editor at the bubble's own position, a revised payload sends through the
 * same verb, empty payloads stay disabled, and cancel restores the bubble
 * without sending.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-runtime/client'
import { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'
import { UserRerunActions } from '../src/client/chat/UserRerunActions.tsx'
import type { ChatNodeViewProps } from '../src/client/contract/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function mountActions(text = '请修改这个文件', onResend = vi.fn(), onReedit = vi.fn()) {
  return {
    ...render(<UserRerunActions text={text} time={1_700_000_000_000} onResend={onResend} onReedit={onReedit} t={t} />),
    onResend,
    onReedit,
  }
}

function mountView(text = '请修改这个文件', rerunUserMessage = vi.fn()) {
  const data: UserMessageNode = {
    kind: 'user',
    seq: 7,
    time: 1_700_000_000_000,
    content: [{ type: 'text', text }] as never,
    source: null,
  }
  const props = {
    node: { kind: 'user', data },
    loadImage: () => Promise.reject(new Error('no image service in this test')),
    rerunUserMessage,
    t,
  } as unknown as ChatNodeViewProps<'user'>
  return { ...render(<UserMessageNodeView {...props} />), rerunUserMessage }
}

describe('UserRerunActions', () => {
  it('re-sends the message verbatim from the re-run button', () => {
    const ui = mountActions('原样重发')
    fireEvent.click(ui.getByLabelText('重发'))
    expect(ui.onResend).toHaveBeenCalledWith('原样重发')
  })

  it('hands the message to the in-place editor from the re-edit button', () => {
    const ui = mountActions('请修改这个文件')
    fireEvent.click(ui.getByLabelText('编辑重发'))
    expect(ui.onReedit).toHaveBeenCalledOnce()
    expect(ui.onResend).not.toHaveBeenCalled()
  })
})

describe('UserMessageNodeView re-edit', () => {
  it('replaces the bubble with the editor in place and re-runs the revised text from the message', () => {
    const ui = mountView('请修改这个文件')
    fireEvent.click(ui.getByLabelText('编辑重发'))
    // The editor opens inside the message's own row, and the bubble is gone.
    const row = ui.container.querySelector('[data-time-hover-root]') as HTMLElement
    const editor = row.querySelector('[data-user-reedit-editor]') as HTMLElement
    expect(editor).not.toBeNull()
    expect(row.querySelector('div[class*="bubble"]')).toBeNull()
    const input = editor.querySelector('textarea') as HTMLTextAreaElement
    expect(input.value).toBe('请修改这个文件')
    fireEvent.change(input, { target: { value: '请修改那个文件' } })
    fireEvent.click(ui.getByText('发送'))
    // The re-run anchors at the message's own event seq so the host can fork
    // at the completed turn before it.
    expect(ui.rerunUserMessage).toHaveBeenCalledWith(7, '请修改那个文件')
    // The editor closes after a successful re-send and the bubble returns.
    expect(ui.container.querySelector('[data-user-reedit-editor]')).toBeNull()
    expect(ui.getByText('请修改这个文件')).toBeTruthy()
  })

  it('disables send for an emptied payload and cancel restores the bubble', () => {
    const ui = mountView('原文本')
    fireEvent.click(ui.getByLabelText('编辑重发'))
    const editor = ui.container.querySelector('[data-user-reedit-editor]') as HTMLElement
    const input = editor.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '   ' } })
    expect((ui.getByText('发送') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(ui.getByText('取消'))
    expect(ui.container.querySelector('[data-user-reedit-editor]')).toBeNull()
    expect(ui.getByText('原文本')).toBeTruthy()
    expect(ui.rerunUserMessage).not.toHaveBeenCalled()
  })
})
