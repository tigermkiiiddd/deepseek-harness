/**
 * team domain zod schemas. Every method carries plain string payloads and
 * returns JSON views; schemas mirror the wire shape exactly.
 */

import { z } from 'zod'
import type { Wire } from './rpc.schema.ts'
import type { RequestPayload, ResponseValue } from './index.ts'

/** team.list request payload (empty). */
export const teamListRequestSchema = z.object({}) as unknown as z.ZodType<Wire<RequestPayload<'team.list'>>>

/** team.list response value. */
export const teamListValueSchema = z.array(z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.string(),
})) as unknown as z.ZodType<Wire<ResponseValue<'team.list'>>>

/** team.sessions request payload. */
export const teamSessionsRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.sessions'>>>

/** team.sessions response value. */
export const teamSessionsValueSchema = z.array(z.object({
  sessionId: z.string(),
  cwd: z.string(),
})) as unknown as z.ZodType<Wire<ResponseValue<'team.sessions'>>>

/** team.history request payload. */
export const teamHistoryRequestSchema = z.object({
  memberId: z.string(),
  sessionId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.history'>>>

/** team.history response value. */
export const teamHistoryValueSchema = z.array(z.object({
  role: z.union([z.literal('user'), z.literal('assistant')]),
  text: z.string(),
})) as unknown as z.ZodType<Wire<ResponseValue<'team.history'>>>

/** team.newSession request payload. */
export const teamNewSessionRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.newSession'>>>

/** team.newSession response value. */
export const teamNewSessionValueSchema = z.object({
  sessionId: z.string(),
}) as unknown as z.ZodType<Wire<ResponseValue<'team.newSession'>>>

/** team.chat request payload. */
export const teamChatRequestSchema = z.object({
  memberId: z.string(),
  sessionId: z.string(),
  text: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.chat'>>>

/** team.chat response value. */
export const teamChatValueSchema = z.object({
  text: z.string(),
  stopReason: z.string(),
}) as unknown as z.ZodType<Wire<ResponseValue<'team.chat'>>>
