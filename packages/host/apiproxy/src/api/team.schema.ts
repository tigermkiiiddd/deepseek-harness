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
  kind: z.literal('dsh').optional(),
  status: z.string(),
  capabilities: z.unknown().optional(),
  autostart: z.boolean(),
  lastError: z.string().optional(),
})) as unknown as z.ZodType<Wire<ResponseValue<'team.list'>>>

/** team.start request payload. */
export const teamStartRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.start'>>>

/** team.start response value (empty). */
export const teamStartValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.start'>>>

/** team.stop request payload. */
export const teamStopRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.stop'>>>

/** team.stop response value (empty). */
export const teamStopValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.stop'>>>

/** team.restart request payload. */
export const teamRestartRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.restart'>>>

/** team.restart response value (empty). */
export const teamRestartValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.restart'>>>

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

/** team.prompt request payload. */
export const teamPromptRequestSchema = z.object({
  memberId: z.string(),
  sessionId: z.string(),
  text: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.prompt'>>>

/** team.prompt response value (the accepted turn's prompt id). */
export const teamPromptValueSchema = z.object({
  promptId: z.string(),
}) as unknown as z.ZodType<Wire<ResponseValue<'team.prompt'>>>

/** team.cancel request payload. */
export const teamCancelRequestSchema = z.object({
  memberId: z.string(),
  sessionId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.cancel'>>>

/** team.cancel response value (empty). */
export const teamCancelValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.cancel'>>>

/** team.permission request payload. */
export const teamPermissionRequestSchema = z.object({
  memberId: z.string(),
  requestId: z.string(),
  outcome: z.union([
    z.object({ outcome: z.literal('selected'), optionId: z.string() }),
    z.object({ outcome: z.literal('cancelled') }),
  ]),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.permission'>>>

/** team.permission response value (empty). */
export const teamPermissionValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.permission'>>>

/** team.addMember request payload. */
export const teamAddMemberRequestSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  kind: z.literal('dsh').optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  permission: z.union([z.literal('allow'), z.literal('reject')]).optional(),
  autostart: z.boolean().optional(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.addMember'>>>

/** team.addMember response value (the joined member's snapshot). */
export const teamAddMemberValueSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  kind: z.literal('dsh').optional(),
  status: z.string(),
  capabilities: z.unknown().optional(),
  autostart: z.boolean(),
  lastError: z.string().optional(),
}) as unknown as z.ZodType<Wire<ResponseValue<'team.addMember'>>>

/** team.removeMember request payload. */
export const teamRemoveMemberRequestSchema = z.object({
  memberId: z.string(),
}) as unknown as z.ZodType<Wire<RequestPayload<'team.removeMember'>>>

/** team.removeMember response value (empty). */
export const teamRemoveMemberValueSchema = z.object({}) as unknown as z.ZodType<Wire<ResponseValue<'team.removeMember'>>>
