/**
 * Member-side session-log export: assembles one ZIP archive whose files are
 * the stored artifact text verbatim plus every referenced media object — the
 * same archive shape the main instance's download produces, served over the
 * `dsh/session/export` wire method as base64 (a member topic's log is bounded
 * by the same spill and compaction policies as any other session, so holding
 * one archive in memory is safe).
 *
 * Version one exports the root artifact and its referenced media only;
 * subagent-descendant inclusion is deferred until the lineage seam is needed
 * by a consumer.
 *
 * @module @deepseek-ai/dsh-acp/export
 */

import { Zip, ZipDeflate } from 'fflate'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The persistence backend surface export needs: verbatim raw-artifact reads. */
interface RawArtifactReader {
  readRaw(id: SessionId, signal?: AbortSignal): Promise<{ readonly filename: string; readonly content: string } | undefined>
}

/** The attachment-store surface export needs: durable image reads. */
interface ExportAttachmentStore {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ readonly data: Uint8Array }>
}

/** Zip extension for each accepted raster media type. */
const MEDIA_TYPE_EXTENSIONS: Record<ImageAttachmentRef['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** One exported file: a stored artifact text or one referenced media object. */
type ExportEntry =
  | { readonly path: string; readonly content: string }
  | { readonly path: string; readonly data: Uint8Array }

/**
 * Collect every image reference inside one content array, descending into
 * nested tool results the way the host's live attachment route does.
 * @param content - an event content array (or nested tool-result content).
 * @param refs - the dedupe map being filled (keyed by attachment id).
 */
function collectImageRefs(content: unknown, refs: Map<string, ImageAttachmentRef>): void {
  if (!Array.isArray(content)) return
  const pending: unknown[] = []
  for (const item of content) pending.push(item)
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const block = value as { type?: unknown; attachment?: unknown; content?: unknown }
    if (block.type === 'image' && typeof block.attachment === 'object' && block.attachment !== null) {
      const ref = block.attachment as ImageAttachmentRef
      refs.set(String(ref.attachmentId), ref)
    }
    if (Array.isArray(block.content)) {
      for (const item of block.content) pending.push(item)
    }
  }
}

/**
 * Collect every image reference one session event carries, across the same
 * carriers the host export scans (direct content, message content, inserted
 * messages, and completed assistant chunk blocks).
 * @param event - one parsed JSONL event object.
 * @param refs - the dedupe map being filled (keyed by attachment id).
 */
function collectEventImageRefs(event: unknown, refs: Map<string, ImageAttachmentRef>): void {
  const data = (event as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return
  const carrier = data as {
    content?: unknown
    message?: { content?: unknown }
    inserted?: Array<{ content?: unknown }>
    chunk?: { type?: unknown; block?: unknown }
  }
  collectImageRefs(carrier.content, refs)
  if (carrier.message !== undefined) collectImageRefs(carrier.message.content, refs)
  if (carrier.inserted !== undefined) {
    for (const message of carrier.inserted) collectImageRefs(message.content, refs)
  }
  if (carrier.chunk?.type === 'block-end') collectImageRefs([carrier.chunk.block], refs)
}

/**
 * Collect the distinct media references one stored artifact text names. Lines
 * that fail to parse cannot reference media and are skipped (the artifact
 * itself is exported verbatim regardless).
 * @param content - the stored artifact text.
 * @returns the dedupe map keyed by attachment id.
 */
function imageRefsInArtifact(content: string): Map<string, ImageAttachmentRef> {
  const refs = new Map<string, ImageAttachmentRef>()
  for (const line of content.split('\n')) {
    if (line === '') continue
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    collectEventImageRefs(event, refs)
  }
  return refs
}

/**
 * One safe archive path segment from an untrusted session id: `../`, dot
 * segments, and separator characters are neutralized before they can shape
 * archive entries.
 * @param id - the raw session id.
 * @returns a filesystem-safe single path segment.
 */
function safeSessionIdSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** Balanced DEFLATE level shared with the host's default export quality. */
const COMPRESSION_LEVEL = 6

/**
 * Build the whole export archive for one session: the raw artifact first,
 * then every distinct media object its log references (content-addressed, so
 * a shared image lands once).
 * @param ctx - the bridge context carrying the persistence and attachment seams.
 * @param sessionId - the session whose log is exported.
 * @param signal - cancellation observed across artifact and media reads.
 * @returns the sanitized archive filename and the complete zip bytes.
 */
export async function buildExportArchive(
  ctx: Context,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<{ readonly filename: string; readonly zip: Uint8Array }> {
  const persistence = ctx.get('sessionPersistence') as RawArtifactReader | undefined
  if (persistence?.readRaw === undefined) {
    throw new Error('export requires a persistence backend with raw artifact reads')
  }
  const raw = await persistence.readRaw(sessionId, signal)
  signal.throwIfAborted()
  if (raw === undefined) {
    throw new Error(`unknown session: ${String(sessionId)}`)
  }

  const entries: ExportEntry[] = [{ path: raw.filename, content: raw.content }]
  const attachments = ctx.get('attachments') as ExportAttachmentStore | undefined
  if (attachments !== undefined) {
    for (const ref of imageRefsInArtifact(raw.content).values()) {
      signal.throwIfAborted()
      const stored = await attachments.readImage(ref, signal)
      signal.throwIfAborted()
      entries.push({
        path: `media/${String(ref.attachmentId)}.${MEDIA_TYPE_EXTENSIONS[ref.mediaType]}`,
        data: stored.data,
      })
    }
  }

  const chunks: Uint8Array[] = []
  const archive = new Zip((_error, data, final) => {
    if (data.byteLength > 0) chunks.push(data)
    void final
  })
  for (const entry of entries) {
    const deflate = new ZipDeflate(entry.path, { level: COMPRESSION_LEVEL })
    archive.add(deflate)
    if ('content' in entry) {
      deflate.push(new TextEncoder().encode(entry.content), true)
    } else {
      deflate.push(entry.data, true)
    }
  }
  archive.end()

  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const zip = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    zip.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { filename: `dsh-session-${safeSessionIdSegment(String(sessionId))}.zip`, zip }
}
