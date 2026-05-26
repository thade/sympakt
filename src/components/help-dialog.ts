import { LitElement, html, css } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { theme, sharedStyles } from '../styles/theme.js';

/**
 * Modal dialog with help / instructions.
 */
@customElement('sp-help-dialog')
export class HelpDialog extends LitElement {
  static override styles = [
    theme,
    sharedStyles,
    css`
      :host {
        display: none;
      }

      :host([open]) {
        display: block;
      }

      .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.75);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .dialog {
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        padding: 24px;
        width: 90vw;
        max-width: 560px;
        max-height: 80vh;
        display: flex;
        flex-direction: column;
      }

      h2 {
        font-family: var(--font-pixel);
        font-size: 10px;
        color: var(--accent);
        margin: 0 0 16px 0;
        text-transform: uppercase;
        letter-spacing: 2px;
        flex-shrink: 0;
      }

      .content {
        overflow-y: auto;
        flex: 1;
        min-height: 0;
        padding-right: 8px;
      }

      .content::-webkit-scrollbar {
        width: 6px;
      }

      .content::-webkit-scrollbar-track {
        background: var(--bg-primary);
      }

      .content::-webkit-scrollbar-thumb {
        background: var(--border-color);
      }

      h3 {
        font-family: var(--font-pixel);
        font-size: 8px;
        color: var(--warning);
        margin: 22px 0 10px 0;
        text-transform: uppercase;
        letter-spacing: 2px;
        padding-bottom: 6px;
        border-bottom: 1px solid var(--border-color);
      }

      h3:first-child {
        margin-top: 0;
      }

      p, li {
        font-size: 8px;
        color: var(--text-secondary);
        line-height: 1.55;
        margin: 0 0 6px 0;
      }

      ul {
        margin: 0 0 6px 0;
        padding-left: 16px;
      }

      li {
        margin-bottom: 3px;
      }

      kbd {
        font-family: var(--font-mono);
        font-size: 10px;
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        padding: 1px 4px;
        color: var(--text-primary);
      }

      .accent {
        color: var(--accent);
      }

      .button-row {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
        margin-top: 16px;
        flex-shrink: 0;
      }
    `,
  ];

  @property({ type: Boolean, reflect: true }) open = false;

  override render() {
    if (!this.open) return null;

    return html`
      <div class="overlay" @click=${this.onOverlayClick}>
        <div class="dialog" @click=${(e: Event) => e.stopPropagation()}>
          <h2>Help</h2>
          <div class="content">
            <h3>About</h3>
            <p>
              Sympakt builds 64-slot sample packs for the
              <span class="accent">Elektron Syntakt</span>. Everything runs in
              your browser — no uploads, no account.
            </p>

            <h3>Add Samples</h3>
            <ul>
              <li>Drop audio files on an empty slot, or click <span class="accent">+</span> to browse.</li>
              <li>Drop a <span class="accent">.zip</span> on the header to import a full pack.</li>
              <li>Samples are converted to 48 kHz mono on import.</li>
            </ul>

            <h3>Slot Controls</h3>
            <ul>
              <li><span class="accent">Play / Stop</span> — preview the sample.</li>
              <li><span class="accent">Loop</span> — enable looping with crossfade.</li>
              <li><span class="accent">LO</span> — cycle LOFI modes for longer samples.</li>
              <li><span class="accent">Click the name</span> — rename, reverse, edit, set pitch, or enable dual split.</li>
              <li>Drag a slot to reorder it. For dual slots, drag the <span class="accent">slot number</span> to move the whole row, or drag an <span class="accent">A or B half</span> to swap that side with another slot or half (across or within dual slots).</li>
            </ul>

            <h3>Loop Editing</h3>
            <ul>
              <li><span class="accent">Green handles</span> — set loop start / end (snap to zero crossings).</li>
              <li><span class="accent">Blue diamond</span> — adjust crossfade length.</li>
              <li>Switch crossfade direction from the name menu.</li>
              <li>Max loop: 5s (longer with LOFI).</li>
            </ul>

            <h3>Sample Editor</h3>
            <p>
              Name menu → <span class="accent">Edit Sample</span>. Destructive
              edits: trim, reverse, normalize, fade, gain, bitcrush, filter.
              The slicer splits a sample by transient, even divisions, or
              manual markers — to slots or as a ZIP. Enable
              <span class="accent">Pack in dual slots</span> to send pairs of slices
              into dual-split slots and halve the bank footprint.
            </p>

            <h3>LOFI Modes</h3>
            <p>
              Trade fidelity for length. On the Syntakt, pitch the sample
              down to recover the original speed.
            </p>
            <ul>
              <li><span class="accent">LOFI</span> — 10s (2× speed, −1 oct)</li>
              <li><span class="accent">XLOFI</span> — 20s (4× speed, −2 oct)</li>
              <li><span class="accent">SXLOFI / GXLOFI</span> — 40s / 80s (enable in Settings)</li>
            </ul>

            <h3>Dual Split A|B</h3>
            <p>
              Name menu → <span class="accent">Dual split A|B</span>. Two
              samples share one slot, merged into a single WAV. On the
              Syntakt, set the sample start point to choose A or B.
            </p>

            <h3>Virtual Keyboard</h3>
            <p>
              Press <kbd>P</kbd> or click the keyboard icon. Select a slot,
              then play it at any pitch (2 octaves, root C3). For dual slots,
              an <span class="accent">A | B</span> toggle in the keyboard bar
              picks which side is played — press <kbd>Tab</kbd> for a quick
              switch.
            </p>

            <h3>Export</h3>
            <ul>
              <li><span class="accent">Export .zip</span> downloads a ready-to-transfer pack.</li>
              <li>WAV: 16-bit / 48 kHz / mono.</li>
              <li>Non-looped samples are truncated to the slot's max length.</li>
              <li>Looped samples export the loop region with crossfade baked in.</li>
              <li>Metadata is bundled so packs can be re-imported losslessly.</li>
            </ul>

            <h3>Shortcuts</h3>
            <ul>
              <li><kbd>P</kbd> — toggle virtual keyboard</li>
              <li><kbd>A</kbd>–<kbd>L</kbd> / <kbd>W</kbd> <kbd>E</kbd> <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd> <kbd>O</kbd> — play notes</li>
              <li><kbd>←</kbd> <kbd>→</kbd> — shift keyboard octave</li>
              <li><kbd>↑</kbd> <kbd>↓</kbd> — previous / next sample</li>
              <li><kbd>Tab</kbd> — switch A / B side on a dual slot</li>
            </ul>

            <h3>Settings</h3>
            <p>
              Open with the <span class="accent">gear</span> icon. Adjust max
              columns, enable pitch detection, unlock extended LOFI modes, or
              switch to a colorblind-friendly palette.
            </p>

            <h3>Saving</h3>
            <p>
              Your session is auto-saved in the browser. Reload anytime —
              samples, loops, and settings come back. Use
              <span class="accent">Clear</span> to start over.
            </p>
          </div>
          <div class="button-row">
            <button @click=${this.close}>Close</button>
          </div>
        </div>
      </div>
    `;
  }

  private onOverlayClick(): void {
    this.close();
  }

  private close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent('dialog-close'));
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sp-help-dialog': HelpDialog;
  }
}
