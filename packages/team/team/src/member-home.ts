/**
 * Seed one `kind:'dsh'` member's harness home from the main instance, once, at
 * creation. A member is self-contained: it reads only its own `DSH_HOME` at
 * runtime, so before its first spawn the main instance copies the settings and
 * credentials documents into the member's home — and, when the member carries
 * its own preset composition, installs that preset under the member's user
 * preset root and makes it the member's default. After the seed the member and
 * the main instance are decoupled — a restart never re-seeds, so the member's
 * own runtime writes (e.g. a model switch persisted through `member_model`)
 * survive.
 *
 * The copy is a verbatim file copy, not a service round-trip: the member is a
 * fresh `dsh --profile acp` process whose settings and credentials providers
 * read these same files from their own home, so reproducing the bytes is the
 * faithful way to hand the member the main instance's state. A missing source
 * file is skipped (the member simply has no entry for it); a copy error is
 * thrown so a member starts only when its home is truly seeded.
 *
 * @module @deepseek-ai/dsh-team/member-home
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { Document, parseDocument } from 'yaml'
import {
  COMPOSITION_FILE, PRESET_ID, SETTINGS_NAMESPACE, USER_PRESET_DIR, compositionTextProblem,
} from '@deepseek-ai/dsh-agent-presets'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { MemberConfig } from './types.ts'

/** Basename of the credentials document inside a harness home. */
const CREDENTIALS_FILENAME = '.credentials.yaml'

/** Extensions the file-backed settings provider accepts, in lookup order. */
const SETTINGS_EXTENSIONS = ['.yaml', '.yml', '.json']

/**
 * Seed one `kind:'dsh'` member's home from the main instance.
 *
 * @param config - the member to seed. Non-`dsh` members manage their own
 *   environment and are skipped.
 * @param options - test/override seam. `mainHome` defaults to the current
 *   process's harness home (`resolveDshHome()`); the member home is
 *   `<mainHome>/members/<id>`.
 * @returns fulfillment after the home is seeded, or when it already exists.
 */
export async function seedMemberHome(
  config: MemberConfig,
  options: { readonly mainHome?: string } = {},
): Promise<void> {
  if (config.kind !== 'dsh') return
  const mainHome = options.mainHome ?? resolveDshHome()
  const memberHome = join(mainHome, 'members', config.id)
  // Idempotent gate: a home that already exists was seeded at creation. A
  // restart must not re-seed, or it would clobber the member's own writes.
  try {
    await stat(memberHome)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  await mkdir(memberHome, { recursive: true, mode: 0o700 })
  // settings.yaml/.json: copy verbatim so the member's providers read the same
  // namespaces (agent-default-model, agent-presets, ...) the main instance had.
  const settingsPath = await findSettingsFile(mainHome)
  if (settingsPath !== undefined) {
    const contents = await readFile(settingsPath, 'utf8')
    await writeFile(join(memberHome, basename(settingsPath)), contents, { mode: 0o600 })
  }
  // credentials: copy verbatim; the member's local provider reads them live.
  const credentialsPath = join(mainHome, CREDENTIALS_FILENAME)
  try {
    const contents = await readFile(credentialsPath, 'utf8')
    await writeFile(join(memberHome, CREDENTIALS_FILENAME), contents, { mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  // The member's own preset, when it carries one: composition under its user
  // preset root plus a settings default pointing at it, so every session the
  // member creates composes from this member's unique preset instead of the
  // deployment default. Runs inside the idempotency gate: a restart must not
  // rewrite a preset the member already runs on.
  const preset = config.preset
  if (preset !== undefined) {
    await seedMemberPreset(config.id, preset, memberHome)
  }
}

/**
 * Install one member's own preset into its freshly seeded home: write the
 * composition under the member's user preset root, then point the member's
 * settings document at it. The member is a fresh `dsh --profile acp` process
 * whose roster reads exactly these two files from its own home, so writing
 * them is the faithful way to hand the member its persona.
 *
 * @param memberId - the member whose preset is installed.
 * @param composition - the preset's composition text: a YAML top-level list of
 *   plugin rows (persona, tools, prompt sections).
 * @param memberHome - the freshly created member home to install into.
 * @throws when the member id yields no usable preset id, the composition is
 *   not a loadable entry list, or the settings document cannot be patched.
 */
async function seedMemberPreset(memberId: string, composition: string, memberHome: string): Promise<void> {
  const presetId = presetIdFor(memberId)
  // Fail at creation, not at the member's first session: discovery reports a
  // broken preset with this same check, so the verdict matches what the
  // member's own roster would say.
  const problem = compositionTextProblem(composition)
  if (problem !== undefined) {
    throw new Error(`team: member "${memberId}" has an unusable preset composition: ${problem}`)
  }
  const presetDir = join(memberHome, USER_PRESET_DIR, presetId)
  await mkdir(presetDir, { recursive: true, mode: 0o700 })
  // 0600: a composition is the member's persona definition, never world-readable.
  await writeFile(join(presetDir, COMPOSITION_FILE), composition, { mode: 0o600 })
  await setMemberDefaultPreset(memberHome, presetId)
}

/**
 * The preset id one member's own preset takes under its home.
 *
 * Derived from the member id rather than supplied: each member home holds its
 * own preset root, so no two members collide, and the derivation keeps the id
 * a safe path segment — discovery silently skips a directory whose name no
 * preset id could claim, which would leave the composition on disk but
 * unreachable.
 * @param memberId - the member whose preset id is derived.
 * @returns a preset id satisfying PRESET_ID.
 * @throws when the member id yields no usable preset id.
 */
function presetIdFor(memberId: string): string {
  const id = memberId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!PRESET_ID.test(id)) {
    throw new Error(`team: member "${memberId}" has no usable preset id (its id must contain a letter or digit)`)
  }
  return id
}

/**
 * Point the member's settings document at its own preset: set
 * `agent-presets.default` while preserving every other section and comment.
 * Creates a fresh YAML document when the seed copied none, because the member
 * still needs its default recorded even without a main-instance document.
 * @param memberHome - the member home holding (or to be given) the settings document.
 * @param presetId - the preset to make the member's default.
 */
async function setMemberDefaultPreset(memberHome: string, presetId: string): Promise<void> {
  const path = await findSettingsFile(memberHome)
  if (path === undefined) {
    const fresh = join(memberHome, 'settings.yaml')
    const document = new Document({ [SETTINGS_NAMESPACE]: { default: presetId } })
    await writeFile(fresh, document.toString(), { mode: 0o600 })
    return
  }
  const text = await readFile(path, 'utf8')
  if (extname(path) === '.json') {
    // JSON has no comments to preserve; patch the section key in place.
    const root = JSON.parse(text) as Record<string, unknown>
    const section = root[SETTINGS_NAMESPACE]
    root[SETTINGS_NAMESPACE] = {
      ...(typeof section === 'object' && section !== null && !Array.isArray(section) ? section : {}),
      default: presetId,
    }
    await writeFile(path, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 })
    return
  }
  // The member's own provider parses with this same library at boot and fails
  // loud on a broken document; a seed must never write one out.
  const document = parseDocument(text)
  if (document.errors.length > 0) {
    throw new Error(`team: the seeded settings document ${basename(path)} is not valid YAML`)
  }
  document.setIn([SETTINGS_NAMESPACE, 'default'], presetId)
  await writeFile(path, document.toString(), { mode: 0o600 })
}

/**
 * Find the settings document the file-backed provider would read, if one
 * exists. Returns the first existing extension in lookup order, else `undefined`.
 * @param mainHome - the main instance harness home to scan.
 * @returns the existing settings file path, or `undefined` when none exist.
 */
async function findSettingsFile(mainHome: string): Promise<string | undefined> {
  for (const extension of SETTINGS_EXTENSIONS) {
    const candidate = join(mainHome, `settings${extension}`)
    try {
      await stat(candidate)
      return candidate
    } catch (error) {
      // ENOENT for this extension: try the next. Any other error propagates.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return undefined
}
