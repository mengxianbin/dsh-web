/** Browser entry for text-message edit-and-resend. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { MessageEditTail } from './MessageEditTail.tsx'
import { en, zh, type MessageEditKey } from './locales.ts'
import { createSubmitMessageEdit } from './wiring.ts'
import { reportDailyHeartbeat } from './telemetry.ts'

const NS = 'message-edit'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Edit-and-resend surface copy. */
    'message-edit': MessageEditKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Short-lived child reference used while an edited prompt is submitted. */
    messageEdit: unknown
  }
}

/** Required services for the tail slot, dictionaries, fork, prompt, and navigation. */
export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']

/** Register the official completed-Turn list entry without replacing Chat renderers. */
export function apply(ctx: ClientContext): void {
  reportDailyHeartbeat([{ name: '@linxin666/dsh-client-ui-message-edit' }])
  ctx.effect(() => {
    try {
      return ctx.locale.register(NS, { zh, en })
    } catch {
      return () => {}
    }
  }, 'message-edit: dictionaries')

  const submitEdit = createSubmitMessageEdit(ctx.sessions, childId => { ctx.uiWorkspace.openSession(childId) })
  ctx.slots.inject('conversation.chat.turnTail', () => {
    try {
      return ctx.slots.register({
        name: 'conversation.chat.turnTail',
        id: NS,
        order: 10,
        locale: NS,
        inject: () => ({ submitEdit }),
      }, MessageEditTail)
    } catch {
      return () => {}
    }
  })
}

export type { MessageEditTailProps } from './MessageEditTail.tsx'
export type { MessageEditKey } from './locales.ts'
export type { SubmitMessageEditInput } from './wiring.ts'
