/**
 * The credential half of a search-provider card, shared by every provider whose
 * key is written through the credentials domain rather than the settings
 * section: the literal never rides a response, so a card learns only whether
 * one is configured and writes it addressed by the reference the section names.
 */

import type { IApiClient } from '@deepseek-ai/dsh-client-connection/client'

/** What the credentials domain last reported, and for which reference. */
interface CredentialState {
  /** Reference this answer describes; a stale response for another one is dropped. */
  ref: string
  /** Whether any layer supplies a value for it. */
  configured: boolean
  /** Whether `credentials.set` can affect it; false disables the control. */
  writable: boolean
}

/** Tracks one credential reference on behalf of a card. */
export class CredentialControl {
  private state: CredentialState = { ref: '', configured: false, writable: true }

  /**
   * @param api - wire face used for the credential the section references.
   * @param ref - the reference currently in force (re-read at every use, so a
   *   section edit naming another reference is honored by the next call).
   * @param publish - republish the owning card's projection after a state change.
   */
  constructor(
    private readonly api: Pick<IApiClient, 'credentials'>,
    private readonly ref: () => string,
    private readonly publish: () => void,
  ) {}

  /** Whether the Host reports a credential configured for the referenced key. */
  get configured(): boolean {
    return this.state.configured
  }

  /** Whether the credentials domain accepts a write for it; false disables the control. */
  get writable(): boolean {
    return this.state.writable
  }

  /**
   * Ask the credentials domain about the reference currently in force.
   *
   * The answer is stored with the reference it describes: the section can name
   * another reference between the request and its response, and two reads can
   * settle out of order, so a response is published only while it still answers
   * for the reference in force.
   */
  async read(): Promise<void> {
    const ref = this.ref()
    if (ref !== this.state.ref) {
      // A new reference knows nothing yet; keeping the old answer would claim
      // the key is configured under a name nobody has checked.
      this.state = { ref, configured: false, writable: true }
      this.publish()
    }
    let response: Awaited<ReturnType<IApiClient['credentials']['describe']>>
    try {
      response = await this.api.credentials.describe({ refs: [ref] })
    } catch (_credentialReadFailure) {
      // The card stays usable without this: the key control simply reports the
      // last state it knew, and a write still reaches the Host.
      return
    }
    if (!response.result.ok || ref !== this.ref()) return
    const view = response.result.value.credentials[ref]
    const next: CredentialState = {
      ref,
      configured: view?.configured ?? false,
      // An unknown reference is treated as writable: the control stays usable
      // and the Host is what refuses, rather than the card guessing a refusal.
      writable: view?.writable ?? true,
    }
    if (next.configured === this.state.configured && next.writable === this.state.writable) return
    this.state = next
    this.publish()
  }

  /**
   * Re-read after the Host reports a change to the reference this card watches.
   *
   * A key can be written from somewhere else — the Models page addresses the
   * same reference — and the settings section does not change when it is, so
   * without this the badge keeps reporting a state the Host already replaced.
   * @param ref - the reference the Host reports as changed.
   */
  refresh(ref: string): void {
    if (ref !== this.state.ref) return
    void this.read()
  }

  /**
   * Write the staged key, then re-read whether the Host now holds one.
   * @param value - the staged credential literal.
   * @returns whether the Host reports a configured credential afterwards.
   */
  async write(value: string): Promise<boolean> {
    try {
      await this.api.credentials.set({ ref: this.ref(), value })
    } catch (_credentialWriteFailure) {
      // Refusals surface through the re-read below: the Host is the only
      // authority on whether the key now exists.
    }
    await this.read()
    return this.state.configured
  }
}
