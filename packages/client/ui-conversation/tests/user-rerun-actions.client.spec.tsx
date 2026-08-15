// @vitest-environment jsdom
/**
 * UserRerunActions gestures: the re-run button re-sends the message verbatim,
 * the re-edit button opens an inline editor prefilled with the message text,
 * a revised payload sends through the same verb, empty payloads stay
 * disabled, and cancel closes the editor without sending.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { UserRerunActions } from '../src/client/chat/UserRerunActions.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

function mount(text = '请修改这个文件', onResend = vi.fn()) {
  return {
    ...render(<UserRerunActions text={text} time={1_700_000_000_000} onResend={onResend} t={t} />),
    onResend,
  }
}

describe('UserRerunActions', () => {
  it('re-sends the message verbatim from the re-run button', () => {
    const ui = mount('原样重发')
    fireEvent.click(ui.getByLabelText('重发'))
    expect(ui.onResend).toHaveBeenCalledWith('原样重发')
  })

  it('edits the message inline and re-sends the revised text', async () => {
    const ui = mount('请修改这个文件', vi.fn())
    fireEvent.click(ui.getByLabelText('编辑重发'))
    const editor = await waitFor(() => ui.container.querySelector('[data-user-reedit-editor]') as HTMLElement)
    expect(editor).not.toBeNull()
    const input = editor.querySelector('textarea') as HTMLTextAreaElement
    expect(input.value).toBe('请修改这个文件')
    fireEvent.change(input, { target: { value: '请修改那个文件' } })
    fireEvent.click(ui.getByText('发送'))
    expect(ui.onResend).toHaveBeenCalledWith('请修改那个文件')
    // The editor closes after a successful re-send.
    expect(ui.container.querySelector('[data-user-reedit-editor]')).toBeNull()
  })

  it('disables send for an emptied payload and cancel drops the edit', async () => {
    const ui = mount('原文本', vi.fn())
    fireEvent.click(ui.getByLabelText('编辑重发'))
    const editor = await waitFor(() => ui.container.querySelector('[data-user-reedit-editor]') as HTMLElement)
    const input = editor.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(input, { target: { value: '   ' } })
    expect((ui.getByText('发送') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(ui.getByText('取消'))
    expect(ui.container.querySelector('[data-user-reedit-editor]')).toBeNull()
    expect(ui.onResend).not.toHaveBeenCalled()
  })
})
