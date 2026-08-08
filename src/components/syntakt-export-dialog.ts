import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, sharedStyles } from '../styles/theme.js';
import { modalOverlayStyles } from './modal-styles.js';
import { formatSyntaktTransferCompletion, formatSyntaktTransferPhase } from '../services/syntakt-transfer.js';
import type { BankTransferProgress } from '../services/syntakt-transfer.js';

/** Final confirmation and progress view for a guarded Syntakt bank export. */
@customElement('sp-syntakt-export-dialog')
export class SyntaktExportDialog extends LitElement {
  static override styles = [theme, sharedStyles, modalOverlayStyles, css`
    .overlay { z-index: 2100; }
    .dialog {
      width: min(440px, 100%);
      border: 1px solid var(--warning);
      background: var(--bg-secondary);
      box-shadow: 8px 8px 0 rgba(0,0,0,.35);
    }
    .head {
      padding: 20px 22px 14px;
      border-bottom: 1px solid var(--border-color);
      background: linear-gradient(110deg, #231a10, var(--bg-secondary));
    }
    h2 {
      margin: 0 0 8px;
      color: var(--warning);
      font-family: var(--font-pixel);
      font-size: 10px;
      letter-spacing: 2px;
      text-transform: uppercase;
    }
    .subhead {
      color: var(--text-muted);
      font-family: var(--font-pixel);
      font-size: 6px;
      letter-spacing: 1px;
      line-height: 1.7;
      text-transform: uppercase;
    }
    .content { padding: 18px 22px 20px; }
    .notice {
      margin: 0 0 16px;
      border-left: 2px solid var(--warning);
      padding-left: 10px;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.45;
    }
    .notice strong { color: var(--warning); }
    .summary {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px 12px;
      margin: 14px 0;
      padding: 12px;
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      font-family: var(--font-mono);
      font-size: 10px;
    }
    .summary span:nth-child(odd) { color: var(--text-muted); }
    .summary span:nth-child(even) { color: var(--text-primary); text-align: right; }
    .check {
      display: flex;
      align-items: flex-start;
      gap: 9px;
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--border-color);
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.4;
    }
    .check.confirm { border-color: var(--warning-dim); }
    .check input { width: auto; margin: 1px 0 0; accent-color: var(--warning); }
    .hint {
      margin: 5px 0 0 31px;
      color: var(--text-muted);
      font-family: var(--font-pixel);
      font-size: 6px;
      letter-spacing: 1px;
      line-height: 1.6;
      text-transform: uppercase;
    }
    .progress {
      margin-top: 14px;
      padding: 12px;
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 10px;
    }
    .bar {
      display: grid;
      gap: 1px;
      height: 6px;
      margin-top: 8px;
      overflow: hidden;
      border: 1px solid var(--border-color);
      background: #000;
    }
    .segment { min-width: 0; background: var(--bg-secondary); }
    .segment.complete { background: var(--warning); }
    .result {
      margin: 0;
      border: 1px solid var(--accent);
      padding: 12px;
      color: var(--accent);
      font-family: var(--font-mono);
      font-size: 10px;
      line-height: 1.45;
    }
    .result.error { border-color: var(--danger); color: var(--danger); }
    .button-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
  `];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean }) ready = false;
  @property({ type: Number }) sampleCount = 0;
  @property({ type: String }) deviceName = 'Syntakt';
  @property({ type: Boolean }) transferring = false;
  @property({ attribute: false }) progress: BankTransferProgress | null = null;
  @property({ type: String }) resultMessage = '';
  @property({ type: String }) failureMessage = '';
  @state() private verifyReadback = true;
  @state() private overwriteAcknowledged = false;

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open) {
      this.overwriteAcknowledged = false;
      this.resultMessage = '';
      this.failureMessage = '';
    }
  }

  override render() {
    if (!this.open) return nothing;
    const transferCount = this.progress?.totalFiles || 0;
    const completed = this.progress?.completedFiles || 0;
    const progressLabel = this.progress ? formatProgress(this.progress) : 'Preparing Backup ZIP…';
    return html`<div class="overlay" @click=${this.onOverlayClick}>
      <section
        class="dialog"
        @click=${(event: Event) => event.stopPropagation()}
        aria-label="Export bank to Syntakt"
      >
        <div class="head"><h2>Export to Syntakt</h2><div class="subhead">USB MIDI export</div></div>
        <div class="content">
          ${this.resultMessage ? html`<p class="result">${this.resultMessage}</p>` : nothing}
          ${this.failureMessage ? html`<p class="result error">${this.failureMessage}</p>` : nothing}
          ${!this.resultMessage && !this.failureMessage ? this.renderConfirmation() : nothing}
          ${this.transferring ? html`
            <div class="progress">
              ${progressLabel}
              <div
                class="bar"
                role="progressbar"
                aria-label="Completed Syntakt transfers"
                aria-valuemin="0"
                aria-valuemax=${transferCount}
                aria-valuenow=${completed}
                style=${`grid-template-columns: repeat(${transferCount || 1}, minmax(0, 1fr))`}
              >
                ${Array.from({ length: transferCount }, (_, index) => html`
                  <span class=${index < completed ? 'segment complete' : 'segment'}></span>
                `)}
              </div>
            </div>
          ` : nothing}
          <div class="button-row">
            ${this.transferring
              ? html`<button class="danger" @click=${this.cancel}>Cancel export</button>`
              : html`
                <button @click=${this.close}>
                  ${this.resultMessage || this.failureMessage ? 'Close' : 'Cancel'}
                </button>
                ${!this.resultMessage && !this.failureMessage ? html`
                  <button
                    class="danger"
                    ?disabled=${!this.ready || !this.sampleCount || !this.overwriteAcknowledged}
                    @click=${this.confirm}
                  >Back up and export</button>
                ` : nothing}
              `}
          </div>
        </div>
      </section>
    </div>`;
  }

  private renderConfirmation() {
    if (!this.ready) return html`<p class="result error">Connect a Syntakt before exporting.</p>`;
    return html`
      <p class="notice">
        <strong>${this.sampleCount} sample${this.sampleCount === 1 ? '' : 's'}</strong>
        will replace the same-numbered slots on <strong>${this.deviceName}</strong>.
        A Backup ZIP downloads first.
      </p>
      <div class="summary">
        <span>Mapping</span><span>Sympakt slot N → Syntakt slot N</span>
        <span>Backup</span><span>Backup ZIP download</span>
      </div>
      <label class="check">
        <input
          type="checkbox"
          .checked=${this.verifyReadback}
          @change=${(event: Event) => {
            this.verifyReadback = (event.target as HTMLInputElement).checked;
          }}
        />
        <span>Read back each uploaded sample</span>
      </label>
      <div class="hint">Recommended. Slower, but confirms each upload.</div>
      <label class="check confirm">
        <input
          type="checkbox"
          .checked=${this.overwriteAcknowledged}
          @change=${(event: Event) => {
            this.overwriteAcknowledged = (event.target as HTMLInputElement).checked;
          }}
        />
        <span>
          I understand this replaces ${this.sampleCount} Syntakt sample-library
          slot${this.sampleCount === 1 ? '' : 's'} and may affect projects that use them.
        </span>
      </label>
    `;
  }

  private confirm(): void {
    this.dispatchEvent(new CustomEvent<{ verifyReadback: boolean }>('syntakt-export-confirm', {
      detail: { verifyReadback: this.verifyReadback }, bubbles: true, composed: true,
    }));
  }

  private cancel(): void { this.dispatchEvent(new CustomEvent('syntakt-export-cancel', { bubbles: true, composed: true })); }
  private onOverlayClick(): void { if (!this.transferring) this.close(); }
  private close(): void { if (!this.transferring) this.dispatchEvent(new CustomEvent('dialog-close')); }
}

function formatProgress(progress: BankTransferProgress): string {
  return `${formatSyntaktTransferPhase(progress)} · ${formatSyntaktTransferCompletion(progress)} complete`;
}

declare global { interface HTMLElementTagNameMap { 'sp-syntakt-export-dialog': SyntaktExportDialog; } }
