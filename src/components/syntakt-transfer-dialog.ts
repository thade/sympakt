import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, sharedStyles } from '../styles/theme.js';
import { connectSyntakt, discoverSyntaktDevices, inspectSyntaktSlots, isSyntaktTransferSupported, isSyntaktTransferWriteEnabled, restoreSyntaktBackup, SyntaktBatchTransferError, uploadSympaktBank } from '../services/syntakt-transfer.js';
import type { BankTransferProgress, BankTransferResult, ExplicitSlotMapping, SyntaktConnection } from '../services/syntakt-transfer.js';
import type { WebMidiDevice } from '../midi/web-midi-transport.js';
import type { SyntaktSampleSlot } from '../elektron/syntakt-slot-list.js';
import type { Sample } from '../types/index.js';
import type { ParsedSyntaktBackup } from '../services/syntakt-backup.js';
import { downloadBlob } from '../services/zip-service.js';
import { classifySyntaktTransferResults } from '../services/syntakt-transfer-results.js';
import { downloadSyntaktBank } from '../services/syntakt-import.js';
import type { ImportedSyntaktSlot, SyntaktBankImportProgress } from '../services/syntakt-import.js';

/** A global-library inspector with a guarded same-slot sample-bank writer. */
@customElement('sp-syntakt-transfer-dialog')
export class SyntaktTransferDialog extends LitElement {
  static override styles = [theme, sharedStyles, css`
    :host { display: none; }
    :host([open]) { display: block; }
    .overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0, 0, 0, .78); display: grid; place-items: center; padding: 16px; }
    .dialog { width: min(680px, 100%); max-height: min(760px, calc(100dvh - 32px)); overflow: hidden; border: 1px solid var(--border-color); background: var(--bg-secondary); box-shadow: 8px 8px 0 rgba(0,0,0,.35); display: flex; flex-direction: column; }
    .head { padding: 20px 22px 14px; border-bottom: 1px solid var(--border-color); background: linear-gradient(110deg, var(--bg-secondary), #10231f); }
    h2 { font-family: var(--font-pixel); color: var(--accent); font-size: 10px; letter-spacing: 2px; margin: 0 0 8px; text-transform: uppercase; }
    .subhead { color: var(--text-muted); font-family: var(--font-pixel); font-size: 6px; line-height: 1.7; letter-spacing: 1px; text-transform: uppercase; }
    .content { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 22px 18px; }
    .notice { color: var(--warning); font-family: var(--font-pixel); font-size: 6px; letter-spacing: 1px; line-height: 1.75; border-left: 2px solid var(--warning); padding-left: 10px; margin: 14px 0; text-transform: uppercase; }
    .status { border: 1px solid var(--border-color); padding: 12px; background: var(--bg-primary); margin: 14px 0; }
    .status.connected { border-color: var(--accent); }
    .status.error { border-color: var(--danger); color: var(--danger); }
    .label { display: block; color: var(--text-muted); font-family: var(--font-pixel); font-size: 6px; letter-spacing: 1px; margin-bottom: 6px; text-transform: uppercase; }
    .device { font-family: var(--font-pixel); font-size: 8px; color: var(--accent); letter-spacing: 1px; }
    .detail { color: var(--text-secondary); font-family: var(--font-mono); font-size: 9px; margin-top: 6px; }
    .inventory { border: 1px solid var(--border-color); background: var(--bg-primary); }
    .inventory-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; margin-top: 14px; border: 1px solid var(--border-color); background: var(--bg-primary); color: var(--text-secondary); font-family: var(--font-mono); font-size: 9px; }
    .inventory-summary button { flex: 0 0 auto; padding: 5px 8px; font-size: 6px; }
    .inventory-summary > span:last-child { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
    .inventory-head, .slot { display: grid; grid-template-columns: 42px minmax(0, 1fr) 80px 48px; align-items: center; gap: 8px; }
    .inventory-head { padding: 7px 10px; color: var(--text-muted); background: #101010; border-bottom: 1px solid var(--border-color); font-family: var(--font-pixel); font-size: 6px; letter-spacing: 1px; text-transform: uppercase; }
    .slot { min-height: 29px; padding: 5px 10px; border-bottom: 1px solid rgba(255,255,255,.06); font-family: var(--font-mono); font-size: 10px; }
    .slot:last-child { border-bottom: 0; }
    .slot-number { color: var(--accent); font-family: var(--font-pixel); font-size: 7px; }
    .slot-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
    .slot-size { text-align: right; color: var(--text-secondary); font-size: 9px; }
    .slot-state { color: var(--text-muted); font-family: var(--font-pixel); font-size: 6px; text-align: right; text-transform: uppercase; }
    .slot-state[data-present='true'] { color: var(--accent-dim); }
    .button-row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
    .write-panel { margin-top: 16px; border: 1px solid var(--warning); background: rgba(255, 136, 0, .05); padding: 12px; }
    .write-title { color: var(--warning); font-family: var(--font-pixel); font-size: 7px; letter-spacing: 1px; text-transform: uppercase; }
    .device-picker { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin: 14px 0; }
    .device-picker select { min-width: 0; width: 100%; background: var(--bg-primary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 8px; font-family: var(--font-mono); font-size: 10px; }
    .confirmation { display: flex; align-items: flex-start; gap: 9px; margin-top: 12px; padding: 10px; border: 1px solid var(--warning-dim); color: var(--text-secondary); font-family: var(--font-mono); font-size: 9px; line-height: 1.45; }
    .confirmation input { width: auto; margin: 1px 0 0; accent-color: var(--warning); }
    .progress { margin-top: 12px; color: var(--text-secondary); font-family: var(--font-mono); font-size: 9px; }
    .bar { height: 6px; margin-top: 5px; border: 1px solid var(--border-color); background: var(--bg-primary); }
    .bar > div { height: 100%; background: var(--warning); transition: width .1s linear; }
    @media (max-width: 520px) { .head, .content { padding-left: 14px; padding-right: 14px; } .inventory-head, .slot { grid-template-columns: 34px minmax(0, 1fr) 66px; } .slot-state, .inventory-head span:last-child { display: none; } }
  `];

  @property({ type: Boolean, reflect: true }) open = false;
  @property({ attribute: false }) sampleSlots: ReadonlyArray<Sample | null> = [];
  @property({ type: Boolean }) normalizeOnExport = true;
  @property({ type: Number }) bankRevision = 0;
  @state() private connection: SyntaktConnection | null = null;
  @state() private devices: WebMidiDevice[] = [];
  @state() private selectedDeviceId = '';
  @state() private slots: SyntaktSampleSlot[] = [];
  @state() private showInventory = false;
  @state() private connecting = false;
  @state() private discoveringDevices = false;
  @state() private refreshing = false;
  @state() private transferActive = false;
  @state() private importingBank = false;
  @state() private transferResults: readonly BankTransferResult[] = [];
  @state() private recoveryBackup: ParsedSyntaktBackup | null = null;
  private restoreRevision: number | null = null;
  @state() private restoreAcknowledged = false;
  @state() private error = '';
  private abortController: AbortController | null = null;
  private removeConnectionTerminal: (() => void) | null = null;

  override render() {
    if (!this.open) return nothing;
    const compatible = isSyntaktTransferSupported();
    return html`<div class="overlay" @click=${this.onOverlayClick}>
      <section class="dialog" @click=${(event: Event) => event.stopPropagation()} aria-label="Syntakt sample library inspector">
        <div class="head">
          <h2>Syntakt / Sample Library</h2>
          <div class="subhead">USB MIDI connection</div>
        </div>
        <div class="content">
          ${!compatible ? html`<div class="status error">This browser does not support Web MIDI SysEx here.</div>` : html`
            <div class="status ${this.connection ? 'connected' : ''} ${this.error ? 'error' : ''}">
              <span class="label">Device link</span>
              ${this.connection
                ? html`<div class="device">${this.connection.identity.name} · OS ${this.connection.identity.osVersion}</div><div class="detail">${this.error || `${this.slots.length} of 64 slots read`}</div>`
                : html`<div class="detail">${this.error || 'Connect a Syntakt over USB MIDI. Close Elektron Transfer and Overbridge first.'}</div>`}
            </div>
            ${!this.connection ? this.renderDevicePicker() : nothing}
            ${this.connection ? html`
              <div class="inventory-summary"><span>${this.slots.length === 64 ? '64 slots read' : 'No slot list yet'}</span><span><button ?disabled=${!this.slots.length} @click=${this.toggleInventory}>${this.showInventory ? 'Hide slots' : 'Show 64 slots'}</button></span></div>
              ${this.showInventory ? this.renderInventory() : nothing}
              ${this.transferResults.length ? html`<div class="status ${classifySyntaktTransferResults(this.transferResults).successful ? 'connected' : 'error'}"><span class="label">Last transfer</span><div class="detail">${this.transferResults.map(formatTransferResult).join(' · ')}</div></div>` : nothing}
              ${this.recoveryBackup ? this.renderRestorePanel() : nothing}
            ` : nothing}
            <div class="button-row">
              ${this.isBusy() ? html`<button class="danger" @click=${this.cancelTransfer}>Cancel ${this.importingBank ? 'import' : 'transfer'}</button>` : html`${this.connection ? html`<button class="danger" @click=${this.disconnect}>Disconnect</button>` : nothing}<button @click=${this.close}>Close</button>`}
              ${this.connection ? html`<button class="primary" ?disabled=${this.refreshing || this.isBusy()} @click=${this.refresh}>${this.refreshing ? 'Refreshing…' : 'Refresh inventory'}</button>` : html`<button class="primary" ?disabled=${this.connecting || !this.devices.length} @click=${this.connect}>${this.connecting ? 'Connecting…' : 'Connect selected device'}</button>`}
            </div>
          `}
        </div>
      </section>
    </div>`;
  }

  private renderInventory() {
    return html`<div class="inventory" aria-label="Syntakt global sample library slots">
      <div class="inventory-head"><span>Slot</span><span>Name</span><span>Stored</span><span>Data</span></div>
      ${this.slots.map((slot) => html`
        <div class="slot">
          <span class="slot-number">${String(slot.slot).padStart(2, '0')}</span>
          <span class="slot-name" title=${slot.name}>${slot.name}</span>
          <span class="slot-size">${formatBytes(slot.storedBytes)}</span>
          <span class="slot-state" data-present=${slot.hasData}>${slot.hasData ? 'present' : 'unknown'}</span>
        </div>
      `)}
    </div>`;
  }

  private toggleInventory(): void { this.showInventory = !this.showInventory; }

  override updated(changed: Map<string, unknown>): void {
    if (changed.has('open') && this.open && !this.connection) void this.findDevices();
    if (changed.has('bankRevision') && this.restoreRevision !== null && this.restoreRevision !== this.bankRevision) {
      this.recoveryBackup = null;
      this.restoreRevision = null;
      this.restoreAcknowledged = false;
    }
  }

  /** Arm an exact restore only for the bank atomically loaded from this ZIP. */
  armRestore(backup: ParsedSyntaktBackup, bankRevision: number): void {
    if (this.isBusy()) throw new Error('Cannot load a Syntakt backup during a transfer');
    this.recoveryBackup = backup;
    this.restoreRevision = bankRevision;
    this.restoreAcknowledged = false;
    this.error = '';
  }

  clearRestorePlan(): void {
    this.recoveryBackup = null;
    this.restoreRevision = null;
    this.restoreAcknowledged = false;
  }

  /** Start discovery from the toolbar click, preserving the browser gesture. */
  async openAndDiscover(): Promise<void> {
    this.open = true;
    if (!this.connection) await this.findDevices();
  }

  private renderDevicePicker() {
    return html`<div class="device-picker">
      <select aria-label="USB MIDI device" .value=${this.selectedDeviceId} ?disabled=${this.discoveringDevices || this.connecting || !this.devices.length} @change=${this.selectDevice}>
        <option value="" ?selected=${!this.selectedDeviceId}>${this.devices.length ? 'Choose USB MIDI device…' : 'Find USB MIDI devices first'}</option>
        ${this.devices.map((device) => html`<option value=${device.id} ?selected=${device.id === this.selectedDeviceId}>${device.inputName} ↔ ${device.outputName}</option>`)}
      </select>
      <button ?disabled=${this.discoveringDevices || this.connecting} @click=${this.findDevices}>${this.discoveringDevices ? 'Finding…' : 'Refresh devices'}</button>
    </div>`;
  }

  private async findDevices(): Promise<void> {
    if (this.discoveringDevices || this.connecting) return;
    this.discoveringDevices = true;
    this.error = '';
    try {
      this.devices = await discoverSyntaktDevices();
      const preferred = preferredSyntaktDevice(this.devices);
        this.selectedDeviceId = preferred?.id
          ?? (this.devices.some((device) => device.id === this.selectedDeviceId)
            ? this.selectedDeviceId
          : this.devices[0]?.id ?? '');
    } catch (error) {
      this.devices = [];
      this.selectedDeviceId = '';
      this.error = error instanceof Error ? error.message : 'Could not find USB MIDI devices';
    } finally {
      this.discoveringDevices = false;
    }
  }

  private selectDevice(event: Event): void {
    this.selectedDeviceId = (event.target as HTMLSelectElement).value;
  }

  private async connect(): Promise<void> {
    if (!this.selectedDeviceId) return;
    this.connecting = true; this.error = ''; this.slots = []; this.showInventory = false;
    let connected = false;
    try {
      this.connection = await connectSyntakt(this.selectedDeviceId);
      const connection = this.connection;
      this.removeConnectionTerminal = connection.session.onTerminal((error) => {
        void this.invalidateConnection(error.message, false);
      });
      connected = await this.refresh();
    } catch (error) {
      await this.invalidateConnection(error instanceof Error ? error.message : 'Could not connect to Syntakt');
    } finally {
      this.connecting = false;
      if (connected) this.close();
    }
  }

  private async refresh(): Promise<boolean> {
    if (!this.connection || this.refreshing) return false;
    this.refreshing = true; this.error = '';
    try {
      this.slots = await inspectSyntaktSlots(this.connection);
      this.dispatchConnectionChange(true);
      return true;
    } catch (error) {
      await this.invalidateConnection(error instanceof Error ? error.message : 'Could not read Syntakt slots');
      return false;
    }
    finally {
      this.refreshing = false;
    }
  }

  /** Called by the persistent main-toolbar import button. */
  async importBank(): Promise<void> {
    await this.importAllSlots();
  }

  /** Cancels the current read and invalidates the MIDI session. */
  cancelImport(): void {
    if (this.importingBank) this.abortController?.abort();
  }

  /** Starts the guarded main-toolbar export after its confirmation dialog. */
  async startBankExport(verifyReadback: boolean): Promise<void> {
    if (!this.connection || this.isBusy() || this.slots.length !== 64) {
      this.dispatchExportFailure('Connect a Syntakt before exporting', false);
      return;
    }
    const sourceCount = this.sampleSlots.filter((sample) => sample !== null).length;
    if (!sourceCount) {
      this.dispatchExportFailure('Load at least one Sympakt sample before exporting', false);
      return;
    }
    await this.runTransfer(verifyReadback);
  }

  /** Cancels a main-toolbar export and intentionally closes MIDI for safety. */
  cancelBankExport(): void { if (this.transferActive) this.abortController?.abort(); }

  private async importAllSlots(): Promise<void> {
    if (!this.connection || this.isBusy() || this.slots.length !== 64) return;
    const currentSamples = this.sampleSlots.filter((sample) => sample !== null).length;
    if (!confirm(`Import all 64 Syntakt slots? This replaces the ${currentSamples} sample${currentSamples === 1 ? '' : 's'} currently in Sympakt. The Syntakt will not be changed.`)) return;

    this.importingBank = true;
    this.error = '';
    this.dispatchImportState(true);
    this.abortController = new AbortController();
    try {
      const slots = await downloadSyntaktBank(this.connection, this.slots, {
        signal: this.abortController.signal,
        onProgress: (progress) => {
          this.dispatchImportState(true, progress);
        },
      });
      this.dispatchEvent(new CustomEvent<{ slots: ReadonlyArray<ImportedSyntaktSlot | null> }>('syntakt-bank-import', {
        detail: { slots }, bubbles: true, composed: true,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Syntakt import failed';
      const cancelled = error instanceof DOMException && error.name === 'AbortError';
      this.dispatchEvent(new CustomEvent<{ message: string; cancelled: boolean }>('syntakt-bank-import-failure', {
        detail: { message, cancelled }, bubbles: true, composed: true,
      }));
      await this.invalidateConnection(message);
    } finally {
      this.importingBank = false;
      this.abortController = null;
      this.dispatchImportState(false);
    }
  }

  private renderRestorePanel() {
    const slots = this.recoveryBackup?.manifest.entries.map((entry) => String(entry.targetSlot).padStart(2, '0')) || [];
    const slotList = slots.length <= 2
      ? slots.join(' and ')
      : `${slots.slice(0, -1).join(', ')}, and ${slots[slots.length - 1]}`;
    return html`<section class="write-panel" aria-label="Exact Syntakt backup restoration">
      <div class="write-title">Restore imported Backup ZIP</div>
      <div class="notice">Sympakt checks every slot before restoring. If any slot has changed, it stops before writing.</div>
      <label class="confirmation"><input type="checkbox" .checked=${this.restoreAcknowledged} ?disabled=${this.isBusy()} @change=${(event: Event) => this.restoreAcknowledged = (event.target as HTMLInputElement).checked} /><span>I understand that slots ${slotList} may be replaced with their saved samples.</span></label>
      <div class="button-row"><button class="danger" ?disabled=${!this.restoreAcknowledged || this.isBusy()} @click=${this.startRestore}>Restore backup exactly</button></div>
    </section>`;
  }

  private async runTransfer(verifyReadback: boolean): Promise<void> {
    if (!this.connection || this.isBusy()) return;
    const sourceSlots = this.sampleSlots.flatMap((sample, index) => sample ? [index + 1] : []);
    const mappings: ExplicitSlotMapping[] = [];
    for (const sourceSlot of sourceSlots) {
      const expectedTarget = this.slots.find((slot) => slot.slot === sourceSlot);
      if (!expectedTarget) {
        const message = `Syntakt slot ${sourceSlot} is no longer in the inspected inventory`;
        this.dispatchExportFailure(message, false);
        return;
      }
      mappings.push({ sourceSlot, targetSlot: sourceSlot, expectedTarget });
    }
    this.transferActive = true; this.error = ''; this.transferResults = []; this.recoveryBackup = null; this.restoreRevision = null; this.restoreAcknowledged = false; this.abortController = new AbortController();
    this.dispatchExportState(true);
    try {
      this.transferResults = await uploadSympaktBank(this.connection, this.sampleSlots, {
        mappings,
        normalizeOnExport: this.normalizeOnExport,
        verifyReadback,
        signal: this.abortController.signal,
        onBackupReady: (archive) => {
          downloadBlob(new Blob([archive.buffer as ArrayBuffer], { type: 'application/zip' }), `sympakt-syntakt-backup-${new Date().toISOString().replace(/[-:.TZ]/g, '')}.zip`);
        },
        onProgress: async (progress) => {
          this.dispatchExportState(true, progress);
          await nextPaint();
        },
      });
      this.dispatchExportComplete(this.transferResults, verifyReadback);
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Syntakt transfer failed';
      if (error instanceof SyntaktBatchTransferError) this.transferResults = error.results;
      this.dispatchExportFailure(message, message.startsWith('Transfer cancelled'));
      await this.invalidateConnection(message);
    } finally {
      this.transferActive = false;
      this.abortController = null;
      this.dispatchExportState(false);
    }
  }

  private async startRestore(): Promise<void> {
    if (!this.connection || this.isBusy() || !this.restoreAcknowledged || !isSyntaktTransferWriteEnabled() || !this.recoveryBackup || this.restoreRevision !== this.bankRevision) return;
    this.transferActive = true; this.error = ''; this.transferResults = []; this.abortController = new AbortController();
    try {
      this.transferResults = await restoreSyntaktBackup(this.connection, this.recoveryBackup, {
        signal: this.abortController.signal,
        onProgress: () => undefined,
      });
      this.recoveryBackup = null;
      this.restoreRevision = null;
      this.restoreAcknowledged = false;
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Syntakt backup restoration failed';
      if (error instanceof SyntaktBatchTransferError) this.transferResults = error.results;
      await this.invalidateConnection(message);
    } finally { this.transferActive = false; this.abortController = null; }
  }

  private cancelTransfer(): void { this.abortController?.abort(); }

  private isBusy(): boolean { return this.transferActive || this.importingBank; }

  private dispatchConnectionChange(connected: boolean): void {
    this.dispatchEvent(new CustomEvent<{ connected: boolean; name?: string; importReady?: boolean }>('syntakt-connection-change', {
      detail: connected && this.connection ? { connected: true, name: this.connection.identity.name, importReady: this.slots.length === 64 } : { connected: false, importReady: false },
      bubbles: true,
      composed: true,
    }));
  }

  private dispatchImportState(active: boolean, progress: SyntaktBankImportProgress | null = null): void {
    this.dispatchEvent(new CustomEvent<{ active: boolean; progress: SyntaktBankImportProgress | null }>('syntakt-bank-import-state', {
      detail: { active, progress }, bubbles: true, composed: true,
    }));
  }

  private dispatchExportState(active: boolean, progress: BankTransferProgress | null = null): void {
    this.dispatchEvent(new CustomEvent<{ active: boolean; progress: BankTransferProgress | null }>('syntakt-bank-export-state', {
      detail: { active, progress }, bubbles: true, composed: true,
    }));
  }

  private dispatchExportComplete(results: readonly BankTransferResult[], verifyReadback: boolean): void {
    this.dispatchEvent(new CustomEvent<{ results: readonly BankTransferResult[]; verifyReadback: boolean }>('syntakt-bank-export-complete', {
      detail: { results, verifyReadback }, bubbles: true, composed: true,
    }));
  }

  private dispatchExportFailure(message: string, cancelled: boolean): void {
    this.dispatchEvent(new CustomEvent<{ message: string; cancelled: boolean }>('syntakt-bank-export-failure', {
      detail: { message, cancelled }, bubbles: true, composed: true,
    }));
  }

  private async invalidateConnection(error = '', closeSession = true): Promise<void> {
    const connection = this.connection;
    this.removeConnectionTerminal?.();
    this.removeConnectionTerminal = null;
    this.connection = null;
    this.slots = [];
    this.showInventory = false;
    this.error = error;
    this.dispatchConnectionChange(false);
    if (closeSession) await connection?.session.close().catch(() => undefined);
  }

  private onOverlayClick(): void { if (!this.isBusy()) this.close(); }
  private close(): void {
    if (this.connecting || this.refreshing || this.isBusy()) return;
    // The app keeps this dialog instance mounted. Hiding it must not close the
    // verified MIDI session: disconnecting is an explicit user action below.
    this.error = '';
    this.open = false;
    this.dispatchEvent(new CustomEvent('dialog-close'));
  }

  private async disconnect(): Promise<void> {
    if (this.connecting || this.refreshing || this.isBusy()) return;
    await this.invalidateConnection();
  }
}

function formatTransferResult(result: BankTransferResult): string {
  const labels: Record<BankTransferResult['state'], string> = {
    pending: 'waiting',
    backed_up: 'backed up',
    cleared: 'cleared',
    write_started: 'writing',
    written: 'written',
    verified: 'verified',
    unknown: 'unknown',
  };
  return `Slot ${String(result.targetSlot).padStart(2, '0')} ${labels[result.state]}`;
}

/** Prefer the actual hardware pair over virtual MIDI ports that mention it. */
function preferredSyntaktDevice(devices: readonly WebMidiDevice[]): WebMidiDevice | undefined {
  const exact = (name: string): boolean => name.trim().toLowerCase() === 'elektron syntakt';
  return devices.find((device) => exact(device.inputName) && exact(device.outputName))
    ?? devices.find((device) => /\bsyntakt\b/i.test(`${device.inputName} ${device.outputName}`));
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Let the parent export dialog paint each completed transfer before continuing. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

declare global { interface HTMLElementTagNameMap { 'sp-syntakt-transfer-dialog': SyntaktTransferDialog; } }
