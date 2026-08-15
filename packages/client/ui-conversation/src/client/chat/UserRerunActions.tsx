// User-message re-run / re-edit actions: re-send a settled user message
// verbatim, or open an inline editor to revise the text before re-sending.
// The host treats the result as an ordinary queued prompt that starts its own
// turn, so the original message and its replies stay untouched in the log.

import { useEffect, useRef, useState } from 'react'
import {
  IconEditOutline16, IconRefreshOutline14, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './UserRerunActions.module.css'

/** Props for the user-message re-run / re-edit controls. */
export interface UserRerunActionsProps {
  /** Plain text of the settled user message (the editable payload). */
  text: string
  /** Unix epoch ms shown on the shared icon-actions clock. */
  time?: number | undefined
  /** Re-send one message payload (verbatim or edited) as an ordinary prompt. */
  onResend: (text: string) => void
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render the user-message actions row (copy + re-run + re-edit) and the
 * inline editor while it is open.
 * @param props - message text, event time, the re-send callback, and the locale seat.
 * @returns the actions row with the optional inline editor beneath it.
 */
export function UserRerunActions({ text, time, onResend, t }: UserRerunActionsProps) {
  const [editorOpen, setEditorOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const openEditor = (): void => {
    setDraft(text)
    setEditorOpen(true)
  }

  const resend = (payload: string): void => {
    onResend(payload)
    if (alive.current) {
      setEditorOpen(false)
      setDraft('')
    }
  }

  return (
    <div className={css.root} data-user-rerun-actions>
      <MessageIconActions
        text={text}
        time={time}
        clock="start"
        className={css.actions}
        t={t}
        extraActions={(
          <>
            <Tooltip label={t('user.rerun')} side="bottom">
              <button
                type="button"
                className={css.action}
                aria-label={t('user.rerun')}
                onClick={() => { resend(text) }}
              >
                <IconRefreshOutline14 />
              </button>
            </Tooltip>
            <Tooltip label={t('user.reedit')} side="bottom">
              <button
                type="button"
                className={css.action}
                aria-label={t('user.reedit')}
                onClick={openEditor}
              >
                <IconEditOutline16 />
              </button>
            </Tooltip>
          </>
        )}
      />
      {editorOpen && (
        <div className={css.editor} data-user-reedit-editor>
          <textarea
            className={css.editorInput}
            value={draft}
            rows={Math.min(12, Math.max(3, draft.split('\n').length))}
            aria-label={t('user.reedit')}
            placeholder={t('user.reedit.placeholder')}
            autoFocus
            onChange={(event) => { setDraft(event.target.value) }}
          />
          <span className={css.editorBar}>
            <button
              type="button"
              className={css.editorSend}
              disabled={draft.trim() === ''}
              onClick={() => { resend(draft) }}
            >
              {t('user.reedit.send')}
            </button>
            <button
              type="button"
              className={css.editorCancel}
              onClick={() => { setEditorOpen(false) }}
            >
              {t('user.reedit.cancel')}
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
