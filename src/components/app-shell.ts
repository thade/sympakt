import { LitElement, html, css, nothing } from 'lit';
import { customElement, query, state } from 'lit/decorators.js';
import { theme, sharedStyles, applyColorblindTheme } from '../styles/theme.js';
import { iconHeart, iconGear, iconHelp, iconKeyboard, iconMenu, iconGrid } from '../icons.js';
import { bankState, BankStateController } from '../state/bank-state.js';
import {
  exportSamplePack,
  importSamplePack,
  downloadBlob,
} from '../services/zip-service.js';
import { loadSettings, saveSettings } from '../services/persistence.js';
import type { ExportOptions, Sample, SplitSample } from '../types/index.js';
import { MAX_SLOTS, getSplitMaxDuration } from '../types/index.js';
import { detectPitchWithDebug } from '../services/audio-engine.js';
import { encodeWav } from '../services/wav-encoder.js';
import { formatSyntaktTransferCompletion, formatSyntaktTransferPhase } from '../services/syntakt-transfer.js';
import type { BankTransferProgress, BankTransferResult } from '../services/syntakt-transfer.js';
import { classifySyntaktTransferResults } from '../services/syntakt-transfer-results.js';
import { createSampleFromSyntaktSlot } from '../services/syntakt-import.js';
import type { ImportedSyntaktSlot } from '../services/syntakt-import.js';
import { zipSync } from 'fflate';
import './sample-bank.js';
import './export-dialog.js';
import './settings-dialog.js';
import './help-dialog.js';
import './virtual-keyboard.js';
import './sample-editor.js';
import './syntakt-transfer-dialog.js';
import './syntakt-export-dialog.js';
import type { SampleEditor } from './sample-editor.js';
import type { SyntaktTransferDialog } from './syntakt-transfer-dialog.js';
import type { SyntaktBankImportProgress } from '../services/syntakt-import.js';

/**
 * Main application shell.
 */
@customElement('sp-app')
export class AppShell extends LitElement {
  static override styles = [
    theme,
    sharedStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100vh;
        height: 100dvh;
        background: var(--bg-primary);
        color: var(--text-primary);
      }

      header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color);
        background: var(--bg-secondary);
        flex-shrink: 0;
      }

      .logo {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      h1 {
        font-family: var(--font-pixel);
        font-size: 12px;
        color: var(--accent);
        text-transform: uppercase;
        letter-spacing: 3px;
        margin: 0;
        line-height: 1;
      }

      .subtitle {
        font-family: var(--font-pixel);
        font-size: 7px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 1px;
        line-height: 1;
      }

      @media (max-width: 768px) {
        .logo {
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
        }
      }

      @media (max-width: 480px) {
        .subtitle {
          display: none;
        }
      }

      .toolbar {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .slot-count {
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--text-secondary);
        margin-right: 8px;
      }

      .debug-badge {
        font-family: var(--font-pixel);
        font-size: 7px;
        color: #4fc3f7;
        border: 1px solid #4fc3f7;
        padding: 2px 6px;
        letter-spacing: 1px;
      }

      main {
        flex: 1;
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }

      footer {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 6px 16px;
        border-top: 1px solid var(--border-color);
        background: var(--bg-secondary);
        flex-shrink: 0;
      }

      footer span {
        font-family: var(--font-pixel);
        font-size: 6px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 1px;
      }

      footer a {
        color: var(--accent-dim);
        text-decoration: none;
      }

      footer a:hover {
        color: var(--accent);
      }

      footer .heart {
        color: #e74c3c;
        display: inline-flex;
        vertical-align: middle;
      }

      .notification {
        position: fixed;
        top: 16px;
        left: 50%;
        transform: translateX(-50%);
        background: var(--bg-secondary);
        border: 1px solid var(--accent);
        padding: 10px 16px;
        font-family: var(--font-pixel);
        font-size: 8px;
        color: var(--accent);
        z-index: 2000;
        animation: fadeIn 200ms ease;
        white-space: nowrap;
      }

      .notification.error {
        border-color: var(--danger);
        color: var(--danger);
      }

      @keyframes fadeIn {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }

      button.import-highlight {
        border-color: var(--accent);
        color: var(--accent);
        background: var(--accent-glow);
        box-shadow: 0 0 8px 2px var(--accent-glow);
      }

      input[type='file'] {
        display: none;
      }

      .btn-settings,
      .btn-keyboard {
        padding: 4px 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-keyboard.active {
        background: var(--accent-dim);
        border-color: var(--accent);
        color: #000;
      }

      /* Mobile overflow menu */
      .btn-menu {
        padding: 4px 6px;
        display: none;
        align-items: center;
        justify-content: center;
      }

      .mobile-menu-anchor {
        position: relative;
      }

      .mobile-menu {
        position: absolute;
        top: 100%;
        right: 0;
        margin-top: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        display: flex;
        flex-direction: column;
        z-index: 1000;
        min-width: 140px;
      }

      .mobile-menu button {
        border: none;
        border-bottom: 1px solid var(--border-color);
        text-align: left;
        width: 100%;
        padding: 10px 14px;
      }

      .mobile-menu button:last-child {
        border-bottom: none;
      }

      @media (max-width: 480px) {
        .btn-menu {
          display: inline-flex;
        }
        .desktop-action {
          display: none;
        }
      }
    `,
  ];

  private bankCtrl = new BankStateController(this);

  @state() private exportDialogOpen = false;
  @state() private syntaktTransferOpen = false;
  @state() private syntaktDeviceName = '';
  @state() private syntaktImportReady = false;
  @state() private syntaktImporting = false;
  @state() private syntaktImportProgress: SyntaktBankImportProgress | null = null;
  @state() private syntaktExportOpen = false;
  @state() private syntaktExporting = false;
  @state() private syntaktExportProgress: BankTransferProgress | null = null;
  @state() private syntaktExportResult = '';
  @state() private syntaktExportFailure = '';
  /** True for any dialog-side transfer: export, restore, or bank import. */
  @state() private syntaktBusy = false;
  private syntaktImportBankRevision: number | null = null;
  @state() private notification: { message: string; error: boolean } | null = null;
  @state() private exporting = false;
  @state() private importing = false;
  @state() private exportIncludeOriginals = false;
  @state() private exportNormalize = true;
  @state() private exportPackName = 'My Sample Pack';
  @state() private headerDragOver = false;
  @state() private pitchDebugMode = false;
  @state() private settingsDialogOpen = false;
  @state() private helpDialogOpen = false;
  @state() private pitchDetectionEnabled = false;
  @state() private keyboardOpen = false;
  @state() private maxColumns = 4;
  @state() private colorblindTheme = false;
  @state() private extendedLofiModes = false;
  @state() private loadingDefaultPack = false;
  @state() private mobileMenuOpen = false;
  @state() private editorOpen = false;
  @state() private editorSample: Sample | SplitSample | null = null;
  @state() private editorSlotIndex = 0;
  @state() private editorSide: 'main' | 'a' | 'b' = 'main';

  private notificationTimer?: ReturnType<typeof setTimeout>;
  private zipInput?: HTMLInputElement;
  @query('sp-syntakt-transfer-dialog') private syntaktTransferDialog?: SyntaktTransferDialog;
  private keydownHandler = this.onKeyDown.bind(this);
  private closeMobileMenuHandler = this.closeMobileMenu.bind(this);

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('keydown', this.keydownHandler);
    window.addEventListener('pointerdown', this.closeMobileMenuHandler);
    this.restoreSession();
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('keydown', this.keydownHandler);
    window.removeEventListener('pointerdown', this.closeMobileMenuHandler);
  }

  private async restoreSession(): Promise<void> {
    try {
      const [restored, settings] = await Promise.all([
        bankState.restoreFromDB(),
        loadSettings(),
      ]);
      if (settings) {
        if (settings.packName !== undefined) this.exportPackName = settings.packName;
        if (settings.includeOriginals !== undefined) this.exportIncludeOriginals = settings.includeOriginals;
        if (settings.normalizeOnExport !== undefined) this.exportNormalize = settings.normalizeOnExport;
        if (settings.pitchDetectionEnabled !== undefined) this.pitchDetectionEnabled = settings.pitchDetectionEnabled;
        if (settings.maxColumns !== undefined) this.maxColumns = settings.maxColumns;
        if (settings.colorblindTheme !== undefined) {
          this.colorblindTheme = settings.colorblindTheme;
          applyColorblindTheme(settings.colorblindTheme);
        }
        if (settings.extendedLofiModes !== undefined) this.extendedLofiModes = settings.extendedLofiModes;
      }
      if (restored) {
        const count = this.bankCtrl.slots.filter((s) => s !== null).length;
        this.showNotification(`Restored session — ${count} samples`);
      }
    } catch (err) {
      console.warn('Session restore failed:', err);
    }
  }

  override render() {
    const filledSlots = this.bankCtrl.slots.filter((s) => s !== null).length;
    // While importing, the button is the Cancel control and must stay live.
    const syntaktImportDisabled = !this.syntaktImporting
      && (this.importing || this.syntaktBusy || !this.syntaktImportReady);
    const syntaktImportTitle = this.syntaktImporting
      ? 'Cancel the current Syntakt import'
      : this.syntaktImportReady
        ? 'Import all 64 Syntakt slots into Sympakt'
        : 'Connect a Syntakt before importing';
    const syntaktImportCount = this.syntaktImportProgress?.completedSlots ?? 0;
    const syntaktImportLabel = this.syntaktImporting
      ? `Cancel Syntakt import ${syntaktImportCount}/64`
      : 'Import Syntakt';
    const syntaktExportDisabled = this.importing
      || filledSlots === 0
      || !this.syntaktImportReady
      || this.syntaktBusy;
    const syntaktExportTitle = this.syntaktImportReady
      ? 'Back up and export the current bank to the connected Syntakt'
      : 'Connect a Syntakt before exporting';
    const syntaktExportLabel = this.syntaktExporting
      ? this.syntaktExportProgress
        ? `Syntakt: ${formatSyntaktTransferPhase(this.syntaktExportProgress)} ${formatSyntaktTransferCompletion(this.syntaktExportProgress)}`
        : 'Preparing Syntakt export…'
      : 'Export to Syntakt';
    const syntaktConnectionLabel = this.syntaktDeviceName
      ? `${this.syntaktDeviceName} connected`
      : 'Connect Syntakt';

    return html`
      <header
        @dragover=${this.onHeaderDragOver}
        @dragleave=${this.onHeaderDragLeave}
        @drop=${this.onHeaderDrop}
      >
        <div class="logo">
          <h1>Sympakt</h1>
          <span class="subtitle">Sample Pack Manager</span>
        </div>
        <div class="toolbar">
          <span class="slot-count" title="Filled slots out of 64">${filledSlots}/64</span>
          ${this.pitchDebugMode ? html`<span class="debug-badge" title="Pitch debug mode enabled">DBG</span>` : nothing}
          <button class="btn-settings" @click=${this.onOpenHelp} title="Help">${iconHelp}</button>
          <button class="btn-settings" @click=${this.onOpenSettings} title="Settings">${iconGear}</button>
          <button class="btn-keyboard ${this.keyboardOpen ? 'active' : ''}" @click=${this.onToggleKeyboard} title="Virtual keyboard (P)">${iconKeyboard}</button>
          <button
            class="desktop-action ${this.headerDragOver ? 'import-highlight' : ''}"
            @click=${this.onImportZip}
            ?disabled=${this.importing || this.syntaktImporting || this.syntaktExporting}
            title="Import a sample pack from a .zip file (or drag & drop here)"
          >
            ${this.importing ? 'Importing...' : 'Import .zip'}
          </button>
          <button
            class="desktop-action ${this.syntaktImporting ? 'danger' : 'primary'}"
            @click=${this.onSyntaktImportAction}
            ?disabled=${syntaktImportDisabled}
            title=${syntaktImportTitle}
          >
            ${syntaktImportLabel}
          </button>
          <button
            class="desktop-action primary"
            @click=${this.onOpenExport}
            ?disabled=${filledSlots === 0 || this.exporting}
            title="Export the current bank as a .zip sample pack"
          >
            ${this.exporting ? 'Exporting...' : 'Export .zip'}
          </button>
          <button
            class="desktop-action danger"
            @click=${this.onOpenSyntaktExport}
            ?disabled=${syntaktExportDisabled}
            title=${syntaktExportTitle}
          >
            ${syntaktExportLabel}
          </button>
          <button
            class="desktop-action"
            @click=${this.onOpenSyntaktTransfer}
            title="Choose and connect a Syntakt over USB MIDI"
          >
            ${iconGrid} ${syntaktConnectionLabel}
          </button>
          <button class="desktop-action danger" @click=${this.onClearAll} ?disabled=${filledSlots === 0} title="Remove all samples from the bank">
            Clear
          </button>
          <div class="mobile-menu-anchor">
            <button class="btn-menu" @click=${this.onToggleMobileMenu} title="Actions">${iconMenu}</button>
            ${this.mobileMenuOpen ? html`
              <div class="mobile-menu">
                <button
                  @click=${this.onMobileImport}
                  ?disabled=${this.importing || this.syntaktImporting || this.syntaktExporting}
                >
                  ${this.importing ? 'Importing...' : 'Import .zip'}
                </button>
                <button
                  class="primary"
                  @click=${this.onMobileExport}
                  ?disabled=${filledSlots === 0 || this.exporting}
                >
                  ${this.exporting ? 'Exporting...' : 'Export .zip'}
                </button>
                <button
                  class="danger"
                  @click=${this.onMobileSyntaktExport}
                  ?disabled=${syntaktExportDisabled}
                >${this.syntaktExporting ? 'Exporting Syntakt…' : 'Export to Syntakt'}</button>
                <button @click=${this.onOpenSyntaktTransfer}>${syntaktConnectionLabel}</button>
                <button
                  class=${this.syntaktImporting ? 'danger' : 'primary'}
                  @click=${this.onSyntaktImportAction}
                  ?disabled=${syntaktImportDisabled}
                >${this.syntaktImporting ? `Cancel import ${syntaktImportCount}/64` : 'Import Syntakt'}</button>
                <button class="danger" @click=${this.onMobileClear} ?disabled=${filledSlots === 0}>
                  Clear all
                </button>
              </div>
            ` : nothing}
          </div>
        </div>
      </header>

      <main>
        <sp-sample-bank
          .pitchDebugMode=${this.pitchDebugMode}
          .pitchDetectionEnabled=${this.pitchDetectionEnabled}
          .keyboardOpen=${this.keyboardOpen}
          .maxColumns=${this.maxColumns}
          .extendedLofiModes=${this.extendedLofiModes}
          .loadingDefaultPack=${this.loadingDefaultPack}
          @load-default-pack=${this.onLoadDefaultPack}
          @sample-edit=${this.onSampleEdit}
        ></sp-sample-bank>
      </main>

      ${this.keyboardOpen ? html`<sp-virtual-keyboard></sp-virtual-keyboard>` : nothing}

      <footer>
        <span>
          <a href="https://github.com/sinedied/sympakt" target="_blank" rel="noopener">Sympakt</a>
          · Made with <span class="heart">${iconHeart}</span> and vibes by
          <a href="https://sinedied.github.io" target="_blank" rel="noopener">sinedied</a>
        </span>
      </footer>

      <sp-export-dialog
        ?open=${this.exportDialogOpen}
        .sampleCount=${filledSlots}
        .packName=${this.exportPackName}
        .includeOriginals=${this.exportIncludeOriginals}
        .normalizeOnExport=${this.exportNormalize}
        @dialog-close=${() => (this.exportDialogOpen = false)}
        @export-confirm=${this.onExportConfirm}
      ></sp-export-dialog>

      <sp-syntakt-transfer-dialog
        ?open=${this.syntaktTransferOpen}
        .sampleSlots=${this.bankCtrl.slots}
        .bankRevision=${bankState.revision}
        .normalizeOnExport=${this.exportNormalize}
        @dialog-close=${() => (this.syntaktTransferOpen = false)}
        @syntakt-connection-change=${this.onSyntaktConnectionChange}
        @syntakt-bank-import=${this.onSyntaktBankImport}
        @syntakt-bank-import-state=${this.onSyntaktBankImportState}
        @syntakt-bank-import-failure=${this.onSyntaktBankImportFailure}
        @syntakt-busy-change=${this.onSyntaktBusyChange}
        @syntakt-bank-export-state=${this.onSyntaktBankExportState}
        @syntakt-bank-export-complete=${this.onSyntaktBankExportComplete}
        @syntakt-bank-export-failure=${this.onSyntaktBankExportFailure}
      ></sp-syntakt-transfer-dialog>

      <sp-syntakt-export-dialog
        ?open=${this.syntaktExportOpen}
        .ready=${this.syntaktImportReady}
        .sampleCount=${filledSlots}
        .deviceName=${this.syntaktDeviceName || 'Syntakt'}
        .transferring=${this.syntaktExporting}
        .progress=${this.syntaktExportProgress}
        .resultMessage=${this.syntaktExportResult}
        .failureMessage=${this.syntaktExportFailure}
        @dialog-close=${() => (this.syntaktExportOpen = false)}
        @syntakt-export-confirm=${this.onSyntaktExportConfirm}
        @syntakt-export-cancel=${this.onSyntaktExportCancel}
      ></sp-syntakt-export-dialog>

      <sp-help-dialog
        ?open=${this.helpDialogOpen}
        @dialog-close=${() => (this.helpDialogOpen = false)}
      ></sp-help-dialog>

      <sp-settings-dialog
        ?open=${this.settingsDialogOpen}
        .pitchDetectionEnabled=${this.pitchDetectionEnabled}
        .colorblindTheme=${this.colorblindTheme}
        .extendedLofiModes=${this.extendedLofiModes}
        .maxColumns=${this.maxColumns}
        @dialog-close=${() => (this.settingsDialogOpen = false)}
        @pitch-detection-toggle=${this.onPitchDetectionToggle}
        @colorblind-theme-toggle=${this.onColorblindThemeToggle}
        @extended-lofi-toggle=${this.onExtendedLofiToggle}
        @max-columns-change=${this.onMaxColumnsChange}
      ></sp-settings-dialog>

      <sp-sample-editor
        ?open=${this.editorOpen}
        .sample=${this.editorSample}
        .slotIndex=${this.editorSlotIndex}
        .side=${this.editorSide}
        @dialog-close=${() => (this.editorOpen = false)}
        @editor-apply=${this.onEditorApply}
        @editor-cancel=${() => (this.editorOpen = false)}
        @editor-check-slots=${this.onEditorCheckSlots}
        @editor-export-slices-to-slots=${this.onEditorExportSlicesToSlots}
        @editor-export-slices-zip=${this.onEditorExportSlicesZip}
      ></sp-sample-editor>

      ${this.notification
        ? html`<div class="notification ${this.notification.error ? 'error' : ''}">
            ${this.notification.message}
          </div>`
        : nothing}

      <input type="file" accept=".zip" @change=${this.onZipFileSelected} />
    `;
  }

  private showNotification(message: string, error = false): void {
    this.notification = { message, error };
    clearTimeout(this.notificationTimer);
    this.notificationTimer = setTimeout(() => {
      this.notification = null;
    }, 3000);
  }

  private onImportZip(): void {
    if (!this.zipInput) {
      this.zipInput = this.shadowRoot!.querySelector('input[type="file"]') as HTMLInputElement;
    }
    this.zipInput?.click();
  }

  private onToggleMobileMenu(e: Event): void {
    e.stopPropagation();
    this.mobileMenuOpen = !this.mobileMenuOpen;
  }

  private closeMobileMenu(e: Event): void {
    if (!this.mobileMenuOpen) return;
    const path = e.composedPath();
    const menu = this.shadowRoot?.querySelector('.mobile-menu-anchor');
    if (menu && !path.includes(menu)) {
      this.mobileMenuOpen = false;
    }
  }

  private onMobileImport(): void {
    this.mobileMenuOpen = false;
    this.onImportZip();
  }

  private onMobileExport(): void {
    this.mobileMenuOpen = false;
    this.onOpenExport();
  }

  private onMobileSyntaktExport(): void {
    this.mobileMenuOpen = false;
    this.onOpenSyntaktExport();
  }

  private onMobileClear(): void {
    this.mobileMenuOpen = false;
    this.onClearAll();
  }

  private async onZipFileSelected(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    await this.importZipFile(file);
    input.value = '';
  }

  private async importZipFile(file: File): Promise<void> {
    // Drag-and-drop and the default-pack loader bypass the disabled button, so
    // overlapping imports have to be refused here too.
    if (this.importing) return;
    // A ZIP import replaces the whole bank; during an active Syntakt transfer
    // that must be refused before the bank is touched, not after.
    if (this.syntaktTransferDialog?.isBusy()) {
      this.showNotification('Wait for the Syntakt transfer to finish before importing', true);
      return;
    }
    this.importing = true;
    try {
      const result = await importSamplePack(file, this.pitchDetectionEnabled);
      if (this.syntaktTransferDialog?.isBusy()) {
        this.showNotification('The Syntakt transfer started before the import finished. The bank was not changed.', true);
        return;
      }
      const backup = result.syntaktBackup;
      const slots = backup
        ? backup.manifest.entries.reduce<ReadonlyArray<Sample | null>>((bank, entry) => {
            const original = backup.originals.get(entry.targetSlot);
            const next = [...bank];
            next[entry.targetSlot - 1] = original && !('empty' in original)
              ? createSampleFromSyntaktSlot(
                  { slot: entry.targetSlot, name: original.name, pcm16le: original.pcm16le },
                  this.pitchDetectionEnabled,
                )
              : null;
            return next;
          }, new Array(MAX_SLOTS).fill(null))
        : result.slots;
      bankState.loadBank([...slots]);
      if (backup) this.syntaktTransferDialog?.armRestore(backup, bankState.revision);
      else this.syntaktTransferDialog?.clearRestorePlan();
      this.exportIncludeOriginals = result.includeOriginals;
      this.exportPackName = result.packName;
      this.persistExportOptions();
      const count = slots.filter((s) => s !== null).length;
      if (result.warning) {
        alert(result.warning);
      }
      this.showNotification(backup
        ? `Imported Syntakt backup — ${count} samples. Connect the Syntakt, then choose Restore backup exactly.`
        : `Imported "${result.packName}" — ${count} samples`);
    } catch (err) {
      console.error('Import failed:', err);
      this.showNotification('Failed to import sample pack', true);
    } finally {
      this.importing = false;
    }
  }

  private onHeaderDragOver(e: DragEvent): void {
    e.preventDefault();
    if (e.dataTransfer?.types.includes('Files')) {
      e.dataTransfer.dropEffect = 'copy';
      this.headerDragOver = true;
    }
  }

  private onHeaderDragLeave(e: DragEvent): void {
    const header = e.currentTarget as HTMLElement;
    const related = e.relatedTarget as Node | null;
    if (related && header.contains(related)) return;
    this.headerDragOver = false;
  }

  private async onHeaderDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    this.headerDragOver = false;

    const file = e.dataTransfer?.files[0];
    if (!file || !file.name.toLowerCase().endsWith('.zip')) {
      this.showNotification('Please drop a .zip file', true);
      return;
    }

    await this.importZipFile(file);
  }

  private onOpenExport(): void {
    this.exportDialogOpen = true;
  }

  private onOpenSyntaktTransfer(): void {
    this.mobileMenuOpen = false;
    this.syntaktTransferOpen = true;
    void this.syntaktTransferDialog?.openAndDiscover();
  }

  private onSyntaktBusyChange(event: CustomEvent<{ busy: boolean }>): void {
    this.syntaktBusy = event.detail.busy;
  }

  private onOpenSyntaktExport(): void {
    if (this.importing || !this.syntaktImportReady || this.syntaktBusy) return;
    this.mobileMenuOpen = false;
    this.syntaktExportProgress = null;
    this.syntaktExportResult = '';
    this.syntaktExportFailure = '';
    this.syntaktExportOpen = true;
  }

  private onSyntaktConnectionChange(
    event: CustomEvent<{ connected: boolean; name?: string; importReady?: boolean }>,
  ): void {
    this.syntaktDeviceName = event.detail.connected ? (event.detail.name || 'Syntakt') : '';
    this.syntaktImportReady = !!event.detail.importReady;
    if (!event.detail.connected) {
      this.syntaktImporting = false;
      this.syntaktImportProgress = null;
      this.syntaktExporting = false;
      this.syntaktExportProgress = null;
    }
  }

  private onSyntaktBankImportState(
    event: CustomEvent<{ active: boolean; progress: SyntaktBankImportProgress | null }>,
  ): void {
    if (event.detail.active && !this.syntaktImporting) this.syntaktImportBankRevision = bankState.revision;
    this.syntaktImporting = event.detail.active;
    this.syntaktImportProgress = event.detail.progress;
    if (!event.detail.active) this.syntaktImportBankRevision = null;
  }

  private onSyntaktImportAction(): void {
    if (this.importing) return;
    if (this.syntaktImporting) {
      this.syntaktTransferDialog?.cancelImport();
      return;
    }
    if (!this.syntaktImportReady || this.syntaktBusy) return;
    void this.syntaktTransferDialog?.importBank();
  }

  private onSyntaktBankImport(
    event: CustomEvent<{ slots: ReadonlyArray<ImportedSyntaktSlot | null> }>,
  ): void {
    try {
      if (this.syntaktImportBankRevision !== bankState.revision) {
        this.showNotification(
          'The import finished, but Sympakt changed while it was running. The imported samples were not applied.',
          true,
        );
        return;
      }
      const samples = event.detail.slots.map((slot) => slot
        ? createSampleFromSyntaktSlot(slot, this.pitchDetectionEnabled)
        : null);
      bankState.replaceAll(samples);
      const count = samples.filter((sample) => sample !== null).length;
      this.exportPackName = 'Syntakt Sample Library';
      this.persistExportOptions();
      this.showNotification(`Imported Syntakt library — ${count} samples`);
    } catch (error) {
      console.error('Syntakt bank import failed:', error);
      this.showNotification('Could not import the Syntakt library', true);
    }
  }

  private onSyntaktBankImportFailure(event: CustomEvent<{ message: string; cancelled: boolean }>): void {
    const message = event.detail.cancelled
      ? 'Import cancelled. Reconnect the Syntakt to continue.'
      : `Syntakt import failed — ${event.detail.message}`;
    this.showNotification(message, !event.detail.cancelled);
  }

  private onSyntaktExportConfirm(event: CustomEvent<{ verifyReadback: boolean }>): void {
    this.syntaktExportResult = '';
    this.syntaktExportFailure = '';
    void this.syntaktTransferDialog?.startBankExport(event.detail.verifyReadback);
  }

  private onSyntaktExportCancel(): void {
    this.syntaktTransferDialog?.cancelBankExport();
  }

  private onSyntaktBankExportState(
    event: CustomEvent<{ active: boolean; progress: BankTransferProgress | null }>,
  ): void {
    this.syntaktExporting = event.detail.active;
    this.syntaktExportProgress = event.detail.progress;
  }

  private onSyntaktBankExportComplete(
    event: CustomEvent<{ results: readonly BankTransferResult[]; verifyReadback: boolean }>,
  ): void {
    const count = event.detail.results.length;
    const summary = classifySyntaktTransferResults(event.detail.results);
    this.syntaktExportResult = summary.verified
      ? `Exported and verified ${count} Syntakt sample${count === 1 ? '' : 's'}.`
      : `Exported ${count} Syntakt sample${count === 1 ? '' : 's'} without readback verification.`;
    this.showNotification(this.syntaktExportResult, !summary.successful);
  }

  private onSyntaktBankExportFailure(event: CustomEvent<{ message: string; cancelled: boolean }>): void {
    this.syntaktExportFailure = event.detail.cancelled
      ? 'Export cancelled. Reconnect the Syntakt to continue.'
      : `Syntakt export failed — ${event.detail.message}`;
    this.showNotification(this.syntaktExportFailure, true);
  }

  private async onExportConfirm(e: CustomEvent<ExportOptions>): Promise<void> {
    this.exporting = true;
    try {
      this.exportIncludeOriginals = e.detail.includeOriginals;
      this.exportNormalize = e.detail.normalizeOnExport;
      this.exportPackName = e.detail.packName.trim() || 'Untitled Pack';
      this.persistExportOptions();
      const blob = await exportSamplePack(this.bankCtrl.slots, e.detail);
      const filename = `${e.detail.packName.replace(/[^a-zA-Z0-9_\- ]/g, '_')}.zip`;
      downloadBlob(blob, filename);
      this.showNotification(`Exported "${e.detail.packName}"`); 
    } catch (err) {
      console.error('Export failed:', err);
      this.showNotification('Failed to export sample pack', true);
    } finally {
      this.exporting = false;
    }
  }

  private onClearAll(): void {
    if (confirm('Clear all slots?')) {
      bankState.clearAll();
      this.exportPackName = 'My Sample Pack';
      this.exportIncludeOriginals = false;
      this.exportNormalize = true;
      this.showNotification('All slots cleared');
    }
  }

  private onOpenHelp(): void {
    this.helpDialogOpen = true;
  }

  private onOpenSettings(): void {
    this.settingsDialogOpen = true;
  }

  private onToggleKeyboard(): void {
    this.keyboardOpen = !this.keyboardOpen;
  }

  private onMaxColumnsChange(e: CustomEvent<{ maxColumns: number }>): void {
    this.maxColumns = e.detail.maxColumns;
    this.persistSettings();
  }

  private onColorblindThemeToggle(e: CustomEvent<{ enabled: boolean }>): void {
    this.colorblindTheme = e.detail.enabled;
    applyColorblindTheme(e.detail.enabled);
    this.persistSettings();
  }

  private onExtendedLofiToggle(e: CustomEvent<{ enabled: boolean }>): void {
    this.extendedLofiModes = e.detail.enabled;
    this.persistSettings();
  }

  private async onPitchDetectionToggle(e: CustomEvent<{ enabled: boolean }>): Promise<void> {
    this.pitchDetectionEnabled = e.detail.enabled;
    this.persistSettings();

    if (e.detail.enabled) {
      // Run pitch detection on all existing samples
      const slots = this.bankCtrl.slots;
      let detected = 0;
      for (let i = 0; i < slots.length; i++) {
        const sample = slots[i];
        if (sample && sample.detectedNote === null) {
          const result = detectPitchWithDebug(sample.audioBuffer);
          bankState.updateSampleNote(i, result.note);
          // Also store debug info
          if (sample.pitchDebug === undefined) {
            const updated = bankState.getSlot(i);
            if (updated) {
              bankState.setSample(i, { ...updated, pitchDebug: result.debug });
            }
          }
          if (result.note) detected++;
        }
      }
      this.showNotification(`Pitch detection enabled — ${detected} notes detected`);
    } else {
      // Clear all pitch data
      bankState.clearAllPitchData();
      this.showNotification('Pitch detection disabled — notes cleared');
    }
  }

  private async onLoadDefaultPack(): Promise<void> {
    this.loadingDefaultPack = true;
    try {
      const response = await fetch('./twinshot.zip');
      if (!response.ok) throw new Error(`Download failed (${response.status})`);
      const blob = await response.blob();
      const file = new File([blob], 'twinshot.zip', { type: 'application/zip' });
      await this.importZipFile(file);
    } catch (err) {
      console.error('Default pack load failed:', err);
      this.showNotification('Failed to load default pack', true);
    } finally {
      this.loadingDefaultPack = false;
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Secret combo: Cmd/Ctrl + Alt + D (Shift optional)
    // Use `code` for keyboard-layout safety on macOS.
    const isModifierMatch = (e.metaKey || e.ctrlKey) && e.altKey;
    const isDKey = e.code === 'KeyD' || e.key.toLowerCase() === 'd';
    if (isModifierMatch && isDKey) {
      e.preventDefault();
      this.pitchDebugMode = !this.pitchDebugMode;
      this.showNotification(`Pitch debug ${this.pitchDebugMode ? 'ON' : 'OFF'}`);
      return;
    }

    // P key (no modifiers, not in input) toggles virtual keyboard
    const origin = e.composedPath()[0];
    if (
      !e.metaKey && !e.ctrlKey && !e.altKey &&
      e.key.toLowerCase() === 'p' &&
      !(origin instanceof HTMLInputElement) &&
      !(origin instanceof HTMLTextAreaElement)
    ) {
      e.preventDefault();
      this.onToggleKeyboard();
    }
  }

  private persistExportOptions(): void {
    this.persistSettings();
  }

  private persistSettings(): void {
    saveSettings({
      packName: this.exportPackName,
      includeOriginals: this.exportIncludeOriginals,
      normalizeOnExport: this.exportNormalize,
      pitchDetectionEnabled: this.pitchDetectionEnabled,
      maxColumns: this.maxColumns,
      colorblindTheme: this.colorblindTheme,
      extendedLofiModes: this.extendedLofiModes,
    }).catch((err) => console.warn('Failed to persist settings:', err));
  }

  // --- Sample Editor ---

  private onSampleEdit(e: CustomEvent<{ index: number; side: 'main' | 'a' | 'b' }>): void {
    const { index, side } = e.detail;
    const slot = bankState.getSlot(index);
    if (!slot) return;

    let sample: Sample | SplitSample | null = null;
    if (side === 'b' && slot.splitSample) {
      sample = slot.splitSample;
    } else {
      sample = slot;
    }
    if (!sample) return;

    this.editorSample = sample;
    this.editorSlotIndex = index;
    this.editorSide = side;
    this.editorOpen = true;
  }

  private onEditorApply(e: CustomEvent<{
    audioBuffer: AudioBuffer;
    waveformData: number[];
    duration: number;
    slotIndex: number;
    side: 'main' | 'a' | 'b';
  }>): void {
    const { audioBuffer, waveformData, duration, slotIndex, side } = e.detail;
    const slot = bankState.getSlot(slotIndex);
    if (!slot) return;

    if (side === 'b' && slot.splitSample) {
      const updatedSplit = {
        ...slot.splitSample,
        audioBuffer,
        waveformData,
        duration,
        isTruncated: false,
        loop: null,
        reversed: false,
      };
      bankState.setSplitSample(slotIndex, updatedSplit);
    } else {
      const updatedSample: Sample = {
        ...slot,
        audioBuffer,
        waveformData,
        duration,
        isTruncated: false,
        loop: null,
        reversed: false,
      };
      bankState.setSample(slotIndex, updatedSample);
    }

    this.showNotification('Sample updated');

    // Update the editor's sample reference so it stays in sync
    if (side === 'b' && slot.splitSample) {
      this.editorSample = { ...slot.splitSample, audioBuffer, waveformData, duration, isTruncated: false, loop: null, reversed: false };
    } else {
      this.editorSample = { ...slot, audioBuffer, waveformData, duration, isTruncated: false, loop: null, reversed: false };
    }
  }

  private onEditorCheckSlots(e: CustomEvent<{ slotIndex: number; sliceCount: number }>): void {
    const { slotIndex, sliceCount } = e.detail;
    const slots = this.bankCtrl.slots;
    const availableSlots = MAX_SLOTS - slotIndex;
    const occupiedCount = slots.slice(slotIndex, slotIndex + sliceCount).filter((s) => s !== null).length;

    const editor = this.shadowRoot!.querySelector('sp-sample-editor') as SampleEditor | null;
    if (!editor) return;

    const warnings: string[] = [];
    if (sliceCount > availableSlots) {
      warnings.push(`Only ${availableSlots} slots available from slot ${slotIndex + 1}. ${sliceCount - availableSlots} slices will be skipped.`);
    }
    if (occupiedCount > 0) {
      warnings.push(`${occupiedCount} slot${occupiedCount > 1 ? 's' : ''} already contain samples and will be overwritten.`);
    }

    if (warnings.length > 0) {
      editor.showSlotWarning(warnings.join(' '));
    } else {
      editor.proceedSliceExport();
    }
  }

  private onEditorExportSlicesToSlots(e: CustomEvent<{
    slotIndex: number;
    packDual?: boolean;
    slices: Array<{
      audioBuffer: AudioBuffer;
      waveformData: number[];
      duration: number;
      name: string;
    }>;
  }>): void {
    const { slotIndex, slices, packDual } = e.detail;

    if (packDual) {
      // Each dual slot holds two slices: A = slice[2k], B = slice[2k+1]
      const splitMax = getSplitMaxDuration('off');
      let written = 0;
      for (let pair = 0; pair * 2 < slices.length; pair++) {
        const targetSlot = slotIndex + pair;
        if (targetSlot >= MAX_SLOTS) break;
        const aSlice = slices[pair * 2];
        const bSlice = slices[pair * 2 + 1]; // may be undefined for the last odd slice

        const aTruncated = aSlice.duration > splitMax;
        const splitSample: SplitSample | null = bSlice
          ? {
              name: bSlice.name,
              originalFileName: `${bSlice.name}.wav`,
              audioBuffer: bSlice.audioBuffer,
              waveformData: bSlice.waveformData,
              duration: bSlice.duration,
              isTruncated: bSlice.duration > splitMax,
              originalFile: new Uint8Array(0),
              loop: null,
              detectedNote: null,
            }
          : null;

        const sample: Sample = {
          id: crypto.randomUUID(),
          name: aSlice.name,
          originalFileName: `${aSlice.name}.wav`,
          audioBuffer: aSlice.audioBuffer,
          waveformData: aSlice.waveformData,
          duration: aSlice.duration,
          isTruncated: aTruncated,
          originalFile: new Uint8Array(0),
          loop: null,
          lofi: 'off',
          detectedNote: null,
          splitEnabled: true,
          splitSample,
        };
        bankState.setSample(targetSlot, sample);
        written += bSlice ? 2 : 1;
      }

      this.editorOpen = false;
      this.showNotification(`${written} slices packed into ${Math.ceil(written / 2)} dual slot${Math.ceil(written / 2) > 1 ? 's' : ''}`);
      return;
    }

    for (let i = 0; i < slices.length; i++) {
      const targetSlot = slotIndex + i;
      if (targetSlot >= MAX_SLOTS) break;

      const slice = slices[i];
      const sample: Sample = {
        id: crypto.randomUUID(),
        name: slice.name,
        originalFileName: `${slice.name}.wav`,
        audioBuffer: slice.audioBuffer,
        waveformData: slice.waveformData,
        duration: slice.duration,
        isTruncated: false,
        originalFile: new Uint8Array(0),
        loop: null,
        lofi: 'off',
        detectedNote: null,
      };
      bankState.setSample(targetSlot, sample);
    }

    this.editorOpen = false;
    this.showNotification(`${Math.min(slices.length, MAX_SLOTS - slotIndex)} slices exported to slots`);
  }

  private onEditorExportSlicesZip(e: CustomEvent<{
    sampleName: string;
    slices: AudioBuffer[];
  }>): void {
    const { sampleName, slices } = e.detail;

    try {
      const files: Record<string, Uint8Array> = {};
      for (let i = 0; i < slices.length; i++) {
        const pcm = slices[i].getChannelData(0);
        const wav = encodeWav(pcm);
        const filename = `${sampleName}_${String(i + 1).padStart(2, '0')}.wav`;
        files[filename] = new Uint8Array(wav);
      }

      const zipped = zipSync(files);
      const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' });
      downloadBlob(blob, `${sampleName}_slices.zip`);
      this.showNotification(`${slices.length} slices exported`);
    } catch (err) {
      console.error('Slice ZIP export failed:', err);
      this.showNotification('Failed to export slices', true);
    }
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'sp-app': AppShell;
  }
}
