// User-message re-run / re-edit actions: re-send a settled user message
// verbatim, or hand the text to the owning view's in-place editor (the bubble
// itself turns into the editor) to revise before re-sending. The host treats
// the result as an ordinary queued prompt that starts its own turn, so the
// original message and its replies stay untouched in the log.

import { useState } from 'react'
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
  /** Re-send the message payload verbatim as an ordinary prompt. */
  onResend: (text: string) => void
  /** Open the message's in-place editor, seeded with the message text. */
  onReedit: () => void
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render the user-message actions row (copy + re-run + re-edit).
 * @param props - message text, event time, the re-send and re-edit callbacks, and the locale seat.
 * @returns the actions row.
 */
export function UserRerunActions({ text, time, onResend, onReedit, t }: UserRerunActionsProps) {
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
                onClick={() => { onResend(text) }}
              >
                <IconRefreshOutline14 />
              </button>
            </Tooltip>
            <Tooltip label={t('user.reedit')} side="bottom">
              <button
                type="button"
                className={css.action}
                aria-label={t('user.reedit')}
                onClick={onReedit}
              >
                <IconEditOutline16 />
              </button>
            </Tooltip>
          </>
        )}
      />
    </div>
  )
}

/** Props for the in-place re-edit editor that replaces a user bubble. */
export interface UserReeditEditorProps {
  /** Message text the draft starts from. */
  initial: string
  /** Send the revised payload as an ordinary prompt and close the editor. */
  onSend: (text: string) => void
  /** Close the editor without sending, restoring the bubble. */
  onCancel: () => void
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Render the in-place editor that occupies the user bubble's own position
 * while a re-edit is open.
 * @param props - the seed text, send/cancel callbacks, and the locale seat.
 * @returns the editor with its send/cancel bar.
 */
export function UserReeditEditor({ initial, onSend, onCancel, t }: UserReeditEditorProps) {
  const [draft, setDraft] = useState(initial)
  return (
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
          onClick={() => { onSend(draft) }}
        >
          {t('user.reedit.send')}
        </button>
        <button
          type="button"
          className={css.editorCancel}
          onClick={onCancel}
        >
          {t('user.reedit.cancel')}
        </button>
      </span>
    </div>
  )
}
