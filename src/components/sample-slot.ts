import { LitElement, html, css, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { theme, sharedStyles } from '../styles/theme.js';
import { Sample, MAX_SAMPLE_DURATION, getEffectiveMaxDuration, getSplitMaxDuration, ALL_NOTES, getNextLofiMode } from '../types/index.js';
import type { LoopSettings } from '../types/index.js';
import { playSample, playSampleLooped } from '../services/audio-engine.js';
import { iconPlay, iconStop, iconLoop, iconCheck, iconClose, iconPlus } from '../icons.js';
import './waveform-view.js';

// Custom MIME types used to mark sympakt drag sources, so drop targets can
// validate compatibility during dragover (when the JSON payload itself can't
// be read for security reasons).
const MT_MAIN_NONSPLIT = 'application/x-sympakt-main-nonsplit';
const MT_MAIN_SPLIT = 'application/x-sympakt-main-split';
const MT_HALF = 'application/x-sympakt-half';

/**
 * A single sample slot in the bank.
 * Displays slot number, sample name, waveform preview, and action buttons.
 * Supports drag-and-drop for file import and reordering.
 */
@customElement('sp-sample-slot')
export class SampleSlot extends LitElement {
  static override styles = [
    theme,
    sharedStyles,
    css`
      :host {
        display: block;
      }

      .slot {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 4px 8px;
        background: var(--bg-slot);
        border: 1px solid var(--border-color);
        height: var(--slot-height);
        transition: all var(--transition);
        cursor: default;
        user-select: none;
      }

      .slot:hover {
        background: var(--bg-slot-hover);
        border-color: var(--border-hover);
      }

      .slot.selected {
        border-color: var(--accent);
        background: var(--accent-glow);
      }

      .slot.drag-over {
        border-color: var(--accent);
        background: var(--accent-glow);
      }

      .slot.dragging {
        opacity: 0.4;
      }

      .slot[draggable='true'] {
        cursor: grab;
      }

      .slot[draggable='true']:active {
        cursor: grabbing;
      }

      .slot-number {
        font-family: var(--font-pixel);
        font-size: 8px;
        color: var(--text-muted);
        min-width: 24px;
        text-align: center;
      }

      .slot-number.draggable {
        cursor: grab;
      }

      .slot-number.draggable:active {
        cursor: grabbing;
      }

      .slot-number.drag-over {
        color: var(--accent);
        background: var(--accent-glow);
        outline: 1px dashed var(--accent);
      }

      .slot-number.dragging {
        opacity: 0.4;
      }

      .waveform-container {
        flex: 1;
        height: 22px;
        position: relative;
        overflow: visible;
      }

      .empty-slot {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-muted);
        font-family: var(--font-pixel);
        font-size: 7px;
        text-transform: uppercase;
        letter-spacing: 2px;
        border: 1px dashed var(--border-color);
      }

      .sample-name-wrap {
        position: relative;
        display: flex;
        align-items: center;
        align-self: stretch;
        cursor: pointer;
      }

      .sample-name-wrap:hover .sample-name {
        color: var(--text-secondary);
      }

      .sample-name {
        font-family: var(--font-pixel);
        font-size: 7px;
        color: var(--text-primary);
        max-width: 200px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        padding: 0 2px;
      }

      .sample-menu {
        position: absolute;
        top: 100%;
        left: 0;
        z-index: 100;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        min-width: 100px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        white-space: nowrap;
      }

      .sample-menu .menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        width: 100%;
        text-align: left;
        padding: 4px 8px;
        font-family: var(--font-pixel);
        font-size: 7px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        min-width: 0;
        height: auto;
        position: relative;
      }

      .sample-menu .menu-item:hover {
        background: var(--accent-glow);
        color: var(--accent);
      }

      .sample-menu .submenu {
        position: absolute;
        left: 100%;
        top: 0;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        max-height: 200px;
        overflow-y: auto;
        min-width: 56px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      }

      .sample-menu .submenu button {
        display: block;
        width: 100%;
        text-align: left;
        padding: 3px 8px;
        font-family: var(--font-pixel);
        font-size: 7px;
        border: none;
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        min-width: 0;
        height: auto;
      }

      .sample-menu .submenu button:hover {
        background: var(--accent-glow);
        color: var(--accent);
      }

      .sample-menu .submenu button.selected {
        color: #4fc3f7;
      }

      .rename-input {
        font-family: var(--font-pixel);
        font-size: 7px;
        color: var(--text-primary);
        background: var(--bg-secondary);
        border: 1px solid var(--accent);
        outline: none;
        padding: 0 2px;
        max-width: 200px;
        width: 100%;
      }

      .detected-note {
        font-family: var(--font-pixel);
        font-size: 7px;
        color: #4fc3f7;
        text-align: center;
        white-space: nowrap;
      }

      .duration {
        font-family: var(--font-mono);
        font-size: 9px;
        color: var(--text-secondary);
        min-width: 36px;
        text-align: right;
      }

      .duration.truncated {
        color: var(--warning);
      }

      .pitch-debug {
        font-family: var(--font-mono);
        font-size: 8px;
        color: var(--text-muted);
        min-width: 96px;
        text-align: left;
        white-space: nowrap;
      }

      .actions {
        display: flex;
        gap: 4px;
        align-items: center;
      }

      .actions button {
        padding: 4px 6px;
        font-size: 7px;
        min-width: 0;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-play {
        font-size: 10px;
        padding: 4px 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .danger.confirm {
        background: var(--danger);
        color: #000;
        font-weight: bold;
      }

      .danger.confirm:hover {
        color: var(--danger);
      }

      .btn-loop {
        font-size: 7px;
        padding: 4px 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-loop.active {
        background: var(--accent-dim);
        border-color: var(--accent);
        color: #000;
      }

      .btn-lofi {
        font-size: 7px;
        padding: 4px 6px;
      }

      .btn-lofi.active {
        background: var(--warning);
        border-color: var(--warning);
        color: #000;
      }

      .btn-lofi.xlofi {
        background: #ff4488;
        border-color: #ff4488;
        color: #000;
      }

      .btn-lofi.sxlofi {
        background: #aa44ff;
        border-color: #aa44ff;
        color: #000;
      }

      .btn-lofi.gxlofi {
        background: #4488ff;
        border-color: #4488ff;
        color: #000;
      }

      input[type='file'] {
        display: none;
      }

      /* Dual split mode styles */
      .split-container {
        display: flex;
        align-items: center;
        gap: 0;
        flex: 1;
        min-width: 0;
      }

      .split-half {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 4px;
        min-width: 0;
      }

      .split-half + .split-half {
        border-left: 1px dashed var(--accent-dim);
        padding-left: 4px;
        margin-left: 4px;
      }

      .split-half.drag-over {
        background: var(--accent-glow);
        border-radius: 2px;
        outline: 1px dashed var(--accent);
      }

      .split-half.dragging {
        opacity: 0.4;
      }

      .split-half[draggable='true'] {
        cursor: grab;
      }

      .split-half[draggable='true']:active {
        cursor: grabbing;
      }

      .split-label {
        font-family: var(--font-pixel);
        font-size: 6px;
        color: var(--accent-dim);
        letter-spacing: 1px;
        flex-shrink: 0;
      }

      .split-half .waveform-container {
        flex: 1;
        height: 22px;
        position: relative;
        overflow: visible;
      }

      .split-half .split-actions {
        display: flex;
        gap: 2px;
        align-items: center;
      }

      .split-half .split-actions button {
        padding: 2px 4px;
        font-size: 7px;
        min-width: 0;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .split-half .sample-name {
        max-width: 80px;
      }

      .shared-actions {
        display: flex;
        gap: 4px;
        align-items: center;
        flex-shrink: 0;
      }

      .shared-actions button {
        padding: 4px 6px;
        font-size: 7px;
        min-width: 0;
        height: 22px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-split {
        font-size: 7px;
        padding: 4px 6px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      .btn-split.active {
        background: var(--accent-dim);
        border-color: var(--accent);
        color: #000;
      }
    `,
  ];

  @property({ type: Number }) index = 0;
  @property({ type: Object }) sample: Sample | null = null;
  @property({ type: Boolean }) pitchDebugMode = false;
  @property({ type: Boolean }) selected = false;
  @property({ type: Boolean }) extendedLofiModes = false;

  @state() private dragOver = false;
  @state() private dragOverA = false;
  @state() private dragOverB = false;
  @state() private dragging = false;
  @state() private draggingA = false;
  @state() private draggingB = false;
  @state() private dragOverNumber = false;
  @state() private playing = false;
  @state() private playingB = false;
  @state() private confirmingRemove = false;
  @state() private sampleMenuOpen = false;
  @state() private splitMenuOpen = false;
  @state() private splitMenuOpenB = false;
  @state() private pitchSubmenuOpen = false;
  @state() private renamingTarget: 'main' | 'a' | 'b' | null = null;
  private stopFn?: () => void;
  private stopFnB?: () => void;
  private playTimer?: ReturnType<typeof setTimeout>;
  private playTimerB?: ReturnType<typeof setTimeout>;
  private outsideClickHandler = this.onOutsideClick.bind(this);
  private stopAllHandler = this.onStopAll.bind(this);
  // Global safety net: a cancelled HTML5 drag (e.g. Escape key, drop outside any
  // valid zone) doesn't always fire `dragleave` on the last hovered drop target,
  // which would otherwise leave a slot stuck in the `drag-over` state. Reset all
  // drag visuals whenever any drag ends or drops anywhere in the document.
  private globalDragEndHandler = (): void => {
    if (
      this.dragging || this.draggingA || this.draggingB ||
      this.dragOver || this.dragOverA || this.dragOverB || this.dragOverNumber
    ) {
      this.dragging = false;
      this.draggingA = false;
      this.draggingB = false;
      this.dragOver = false;
      this.dragOverA = false;
      this.dragOverB = false;
      this.dragOverNumber = false;
    }
  };

  private fileInput?: HTMLInputElement;
  private fileInputB?: HTMLInputElement;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('stop-all-playback', this.stopAllHandler);
    window.addEventListener('dragend', this.globalDragEndHandler);
    window.addEventListener('drop', this.globalDragEndHandler);
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('stop-all-playback', this.stopAllHandler);
    window.removeEventListener('dragend', this.globalDragEndHandler);
    window.removeEventListener('drop', this.globalDragEndHandler);
    document.removeEventListener('click', this.outsideClickHandler);
  }

  private onStopAll(): void {
    if (this.playing) {
      this.stopPlayback();
    }
    if (this.playingB) {
      this.stopPlaybackB();
    }
  }

  override render() {
    const slotNum = String(this.index + 1).padStart(2, '0');
    const cls = `slot${this.dragOver ? ' drag-over' : ''}${this.dragging ? ' dragging' : ''}${this.selected ? ' selected' : ''}`;

    const isSplit = this.sample?.splitEnabled ?? false;
    // In split mode, the .slot itself is not a drag source/target. Instead, the
    // slot-number acts as the whole-slot handle and each half handles its own side.
    const slotDraggable = !!this.sample && !isSplit;
    const numberCls = `slot-number${isSplit ? ' draggable' : ''}${this.dragOverNumber ? ' drag-over' : ''}${this.dragging && isSplit ? ' dragging' : ''}`;

    return html`
      <div
        class=${cls}
        draggable=${slotDraggable ? 'true' : 'false'}
        @dragstart=${this.onDragStart}
        @dragend=${this.onDragEnd}
        @dragover=${isSplit ? undefined : this.onDragOver}
        @dragleave=${isSplit ? undefined : this.onDragLeave}
        @drop=${isSplit ? undefined : this.onDrop}
        @click=${this.onSlotClick}
        @contextmenu=${this.sample ? this.onContextMenu : undefined}
      >
        <span
          class=${numberCls}
          draggable=${isSplit && this.sample ? 'true' : 'false'}
          @dragstart=${this.onNumberDragStart}
          @dragend=${this.onNumberDragEnd}
          @dragover=${isSplit ? this.onNumberDragOver : undefined}
          @dragleave=${isSplit ? this.onNumberDragLeave : undefined}
          @drop=${isSplit ? this.onNumberDrop : undefined}
        >${slotNum}</span>

        ${isSplit
          ? this.renderSplitMode()
          : this.renderNormalMode()}

        <input type="file" accept="audio/*" @change=${this.onFileSelected} />
        <input type="file" accept="audio/*" id="file-input-b" @change=${this.onFileSelectedB} />
      </div>
    `;
  }

  private renderNormalMode() {
    return html`
        <div class="waveform-container">
          ${this.sample
            ? html`
                <sp-waveform
                  .data=${this.sample.waveformData}
                  .duration=${this.sample.duration}
                  .truncated=${this.sample.isTruncated}
                  .loopEnabled=${this.sample.loop !== null}
                  .loop=${this.sample.loop}
                  .audioBuffer=${this.sample.audioBuffer}
                  .lofi=${this.sample.lofi}
                  @loop-change=${this.onLoopChange}
                ></sp-waveform>
              `
            : html`<div class="empty-slot" @click=${this.onClickImport} title="Drop an audio file here or click to browse">Drop or click</div>`}
        </div>

        ${this.sample
          ? html`
              <span class="sample-name-wrap" @click=${this.renamingTarget === 'main' ? undefined : this.toggleSampleMenu}>
                ${this.renamingTarget === 'main'
                  ? html`<input class="rename-input" type="text"
                      .value=${this.sample.name}
                      @keydown=${this.onRenameKeydown}
                      @blur=${this.onRenameBlur}
                      @click=${(e: Event) => e.stopPropagation()}
                    />`
                  : html`<span class="sample-name" title="Click for options">${this.sample.name}</span>`}
                ${this.sampleMenuOpen ? this.renderSampleMenu() : nothing}
              </span>
              ${this.sample.detectedNote
                ? html`<span class="detected-note" title="Detected pitch">${this.sample.detectedNote}</span>`
                : nothing}
              ${this.pitchDebugMode
                ? html`
                    <span class="pitch-debug" title=${this.pitchDebugTitle}>
                      ${this.pitchDebugLabel}
                    </span>
                  `
                : nothing}
              <span class="duration ${this.sample.isTruncated && !this.sample.loop ? 'truncated' : ''}"
                title="${this.sample.loop
                  ? 'Loop duration'
                  : this.sample.isTruncated
                    ? `Sample will be truncated to ${this.effectiveMaxDuration}s on export`
                    : 'Sample duration'}">
                ${this.sample.loop
                  ? formatDuration(this.sample.loop.endTime - this.sample.loop.startTime)
                  : formatDuration(Math.min(this.sample.duration, this.effectiveMaxDuration))}
              </span>
              <div class="actions">
                <button class="btn-play" @click=${this.togglePlay} title="${this.playing ? 'Stop playback' : 'Preview sample'}">
                  ${this.playing ? iconStop : iconPlay}
                </button>
                <button
                  class="btn-loop ${this.sample.loop !== null ? 'active' : ''}"
                  @click=${this.toggleLoop}
                  title="${this.sample.loop !== null ? 'Disable loop — export full sample (up to 5s)' : 'Enable loop — set loop points for seamless looping'}"
                >${iconLoop}</button>
                <button
                  class="btn-lofi ${this.lofiButtonClass}"
                  @click=${this.toggleLofi}
                  title="${this.lofiButtonTitle}"
                >${this.lofiButtonLabel}</button>
                ${this.confirmingRemove
                  ? html`<button class="danger confirm" @click=${this.onConfirmRemove} title="Click to confirm removal">${iconCheck}</button>`
                  : html`<button class="danger" @click=${this.onRemoveClick} title="Remove sample from this slot">${iconClose}</button>`}
              </div>
            `
          : html`
              <div class="actions">
                <button @click=${this.onClickImport} title="Add a sample to this slot">${iconPlus}</button>
              </div>
            `}
    `;
  }

  private renderSplitMode() {
    if (!this.sample) return nothing;
    const splitB = this.sample.splitSample;
    const splitMax = this.splitMaxDuration;
    const aEmpty = !!this.sample.aEmpty;

    return html`
      <div class="split-container">
        <!-- A side -->
        <div class="split-half ${this.dragOverA ? 'drag-over' : ''} ${this.draggingA ? 'dragging' : ''}"
          draggable=${aEmpty ? 'false' : 'true'}
          @dragstart=${this.onHalfDragStartA}
          @dragend=${this.onHalfDragEndA}
          @dragover=${this.onDragOverA}
          @dragleave=${this.onDragLeaveA}
          @drop=${this.onDropA}
        >
          <span class="split-label">A</span>
          ${aEmpty
            ? html`
                <div class="waveform-container">
                  <div class="empty-slot" @click=${this.onClickImport} title="Drop or click to add A sample">Drop or click</div>
                </div>
              `
            : html`
                <div class="waveform-container">
                  <sp-waveform
                    .data=${this.sample.waveformData}
                    .duration=${this.sample.duration}
                    .truncated=${this.sample.isTruncated}
                    .loopEnabled=${this.sample.loop !== null}
                    .loop=${this.sample.loop}
                    .audioBuffer=${this.sample.audioBuffer}
                    .lofi=${this.sample.lofi}
                    .effectiveMaxOverride=${splitMax}
                    @loop-change=${this.onLoopChange}
                  ></sp-waveform>
                </div>
                <span class="sample-name-wrap" @click=${this.renamingTarget === 'a' ? undefined : this.toggleSplitMenu}>
                  ${this.renamingTarget === 'a'
                    ? html`<input class="rename-input" type="text"
                        .value=${this.sample.name}
                        @keydown=${this.onRenameKeydownA}
                        @blur=${this.onRenameBlurA}
                        @click=${(e: Event) => e.stopPropagation()}
                      />`
                    : html`<span class="sample-name" title=${this.sample.name}>${this.sample.name}</span>`}
                  ${this.splitMenuOpen ? this.renderSplitMenu('a') : nothing}
                </span>
                <span class="duration ${this.sample.isTruncated && !this.sample.loop ? 'truncated' : ''}">
                  ${this.sample.loop
                    ? formatDuration(this.sample.loop.endTime - this.sample.loop.startTime)
                    : formatDuration(Math.min(this.sample.duration, splitMax))}
                </span>
                <div class="split-actions">
                  <button class="btn-play" @click=${this.togglePlay} title="${this.playing ? 'Stop A' : 'Play A'}">
                    ${this.playing ? iconStop : iconPlay}
                  </button>
                  <button
                    class="btn-loop ${this.sample.loop !== null ? 'active' : ''}"
                    @click=${this.toggleLoop}
                    title="${this.sample.loop !== null ? 'Disable loop A' : 'Enable loop A'}"
                  >${iconLoop}</button>
                </div>
              `}
        </div>

        <!-- B side -->
        <div class="split-half ${this.dragOverB ? 'drag-over' : ''} ${this.draggingB ? 'dragging' : ''}"
          draggable=${splitB ? 'true' : 'false'}
          @dragstart=${this.onHalfDragStartB}
          @dragend=${this.onHalfDragEndB}
          @dragover=${this.onDragOverB}
          @dragleave=${this.onDragLeaveB}
          @drop=${this.onDropB}
        >
          <span class="split-label">B</span>
          ${splitB
            ? html`
                <div class="waveform-container">
                  <sp-waveform
                    .data=${splitB.waveformData}
                    .duration=${splitB.duration}
                    .truncated=${splitB.isTruncated}
                    .loopEnabled=${splitB.loop !== null}
                    .loop=${splitB.loop}
                    .audioBuffer=${splitB.audioBuffer}
                    .lofi=${this.sample.lofi}
                    .effectiveMaxOverride=${splitMax}
                    @loop-change=${this.onLoopChangeB}
                  ></sp-waveform>
                </div>
                <span class="sample-name-wrap" @click=${this.renamingTarget === 'b' ? undefined : this.toggleSplitMenuB}>
                  ${this.renamingTarget === 'b'
                    ? html`<input class="rename-input" type="text"
                        .value=${splitB.name}
                        @keydown=${this.onRenameKeydownB}
                        @blur=${this.onRenameBlurB}
                        @click=${(e: Event) => e.stopPropagation()}
                      />`
                    : html`<span class="sample-name" title=${splitB.name}>${splitB.name}</span>`}
                  ${this.splitMenuOpenB ? this.renderSplitMenu('b') : nothing}
                </span>
                <span class="duration ${splitB.isTruncated && !splitB.loop ? 'truncated' : ''}">
                  ${splitB.loop
                    ? formatDuration(splitB.loop.endTime - splitB.loop.startTime)
                    : formatDuration(Math.min(splitB.duration, splitMax))}
                </span>
                <div class="split-actions">
                  <button class="btn-play" @click=${this.togglePlayB} title="${this.playingB ? 'Stop B' : 'Play B'}">
                    ${this.playingB ? iconStop : iconPlay}
                  </button>
                  <button
                    class="btn-loop ${splitB.loop !== null ? 'active' : ''}"
                    @click=${this.toggleLoopB}
                    title="${splitB.loop !== null ? 'Disable loop B' : 'Enable loop B'}"
                  >${iconLoop}</button>
                </div>
              `
            : html`
                <div class="waveform-container">
                  <div class="empty-slot" @click=${this.onClickImportB} title="Drop or click to add B sample">Drop or click</div>
                </div>
              `}
        </div>
      </div>

      <!-- Shared actions (LOFI, remove) -->
      <div class="shared-actions">
        <button
          class="btn-lofi ${this.lofiButtonClass}"
          @click=${this.toggleLofi}
          title="${this.lofiButtonTitle}"
        >${this.lofiButtonLabel}</button>
        ${this.confirmingRemove
          ? html`<button class="danger confirm" @click=${this.onConfirmRemove} title="Click to confirm removal">${iconCheck}</button>`
          : html`<button class="danger" @click=${this.onRemoveClick} title="Remove slot">${iconClose}</button>`}
      </div>
    `;
  }

  private onClickImport(): void {
    if (!this.fileInput) {
      this.fileInput = this.shadowRoot!.querySelector('input[type="file"]') as HTMLInputElement;
    }
    this.fileInput?.click();
  }

  private onSlotClick(): void {
    if (this.sample) {
      this.dispatchEvent(
        new CustomEvent('slot-select', {
          detail: { index: this.index },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private onFileSelected(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.dispatchEvent(
        new CustomEvent('sample-import', {
          detail: { index: this.index, file },
          bubbles: true,
          composed: true,
        }),
      );
    }
    input.value = '';
  }

  private onRemoveClick(e: Event): void {
    e.stopPropagation();
    this.confirmingRemove = true;
    requestAnimationFrame(() => {
      document.addEventListener('click', this.outsideClickHandler, { once: true });
    });
  }

  private onConfirmRemove(e: Event): void {
    e.stopPropagation();
    document.removeEventListener('click', this.outsideClickHandler);
    this.confirmingRemove = false;
    this.stopPlayback();
    this.dispatchEvent(
      new CustomEvent('sample-remove', {
        detail: { index: this.index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onOutsideClick(): void {
    this.confirmingRemove = false;
    this.sampleMenuOpen = false;
    this.splitMenuOpen = false;
    this.splitMenuOpenB = false;
    this.pitchSubmenuOpen = false;
  }

  private onContextMenu(e: MouseEvent): void {
    if (!this.sample) return;
    e.preventDefault();
    e.stopPropagation();

    // Close any open menus on other slots (their once-click listeners won't fire on right-click)
    document.dispatchEvent(new MouseEvent('click'));

    const isSplit = this.sample.splitEnabled ?? false;
    if (isSplit) {
      // Determine which half was clicked
      const target = e.composedPath();
      const splitHalves = this.shadowRoot?.querySelectorAll('.split-half');
      if (splitHalves && splitHalves.length >= 2) {
        const isB = target.some(el => el === splitHalves[1]);
        if (isB && this.sample.splitSample) {
          this.splitMenuOpenB = !this.splitMenuOpenB;
          this.splitMenuOpen = false;
          if (this.splitMenuOpenB) {
            requestAnimationFrame(() => {
              document.addEventListener('click', () => {
                this.splitMenuOpenB = false;
              }, { once: true });
            });
          }
        } else {
          this.splitMenuOpen = !this.splitMenuOpen;
          this.splitMenuOpenB = false;
          if (this.splitMenuOpen) {
            requestAnimationFrame(() => {
              document.addEventListener('click', () => {
                this.splitMenuOpen = false;
              }, { once: true });
            });
          }
        }
      }
    } else {
      this.sampleMenuOpen = !this.sampleMenuOpen;
      this.pitchSubmenuOpen = false;
      if (this.sampleMenuOpen) {
        requestAnimationFrame(() => {
          document.addEventListener('click', () => {
            this.sampleMenuOpen = false;
            this.pitchSubmenuOpen = false;
          }, { once: true });
        });
      }
    }
  }

  private toggleSampleMenu(e: Event): void {
    e.stopPropagation();
    this.sampleMenuOpen = !this.sampleMenuOpen;
    this.pitchSubmenuOpen = false;
    if (this.sampleMenuOpen) {
      requestAnimationFrame(() => {
        document.addEventListener('click', () => {
          this.sampleMenuOpen = false;
          this.pitchSubmenuOpen = false;
        }, { once: true });
      });
    }
  }

  private renderSampleMenu() {
    const loop = this.sample?.loop;
    return html`
      <div class="sample-menu" @click=${(e: Event) => e.stopPropagation()}>
        <button class="menu-item" @click=${() => this.startRename('main')}>
          RENAME
        </button>
        <div class="menu-item"
          @mouseenter=${() => { this.pitchSubmenuOpen = true; }}
          @mouseleave=${() => { this.pitchSubmenuOpen = false; }}
        >
          SET PITCH <svg width="6" height="8" viewBox="0 0 6 8" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,1 5,4 1,7"/></svg>
          ${this.pitchSubmenuOpen ? this.renderPitchSubmenu() : nothing}
        </div>
        <button class="menu-item" @click=${this.onReverseSample}>
          REVERSE
        </button>
        ${loop ? html`
          <button class="menu-item" @click=${() => this.onToggleCrossfadePosition('main')}>
            ${loop.crossfadeAtStart ? 'CROSSFADE AT END' : 'CROSSFADE AT START'}
          </button>
        ` : nothing}
        <button class="menu-item" @click=${() => this.onEditSample('main')}>
          EDIT SAMPLE
        </button>
        <button class="menu-item" @click=${this.onToggleSplit}>
          ENABLE DUAL SAMPLE
        </button>
      </div>
    `;
  }

  private toggleSplitMenu(e: Event): void {
    e.stopPropagation();
    this.splitMenuOpen = !this.splitMenuOpen;
    this.splitMenuOpenB = false;
    if (this.splitMenuOpen) {
      requestAnimationFrame(() => {
        document.addEventListener('click', () => {
          this.splitMenuOpen = false;
        }, { once: true });
      });
    }
  }

  private toggleSplitMenuB(e: Event): void {
    e.stopPropagation();
    this.splitMenuOpenB = !this.splitMenuOpenB;
    this.splitMenuOpen = false;
    if (this.splitMenuOpenB) {
      requestAnimationFrame(() => {
        document.addEventListener('click', () => {
          this.splitMenuOpenB = false;
        }, { once: true });
      });
    }
  }

  private renderSplitMenu(side: 'a' | 'b' = 'a') {
    const loop = side === 'b' ? this.sample?.splitSample?.loop : this.sample?.loop;
    const aEmpty = !!this.sample?.aEmpty;
    // The "disable dual" option lives on A by default; when A is empty (no menu accessible there)
    // it falls back to B so the user can still exit dual mode without removing the slot.
    const showDisableDual = side === 'a' || (side === 'b' && aEmpty);
    return html`
      <div class="sample-menu" @click=${(e: Event) => e.stopPropagation()}>
        <button class="menu-item" @click=${() => this.startRename(side)}>
          RENAME
        </button>
        <button class="menu-item" @click=${() => side === 'b' ? this.onReverseSplitSample() : this.onReverseSample()}>
          REVERSE
        </button>
        ${loop ? html`
          <button class="menu-item" @click=${() => this.onToggleCrossfadePosition(side === 'b' ? 'split' : 'main')}>
            ${loop.crossfadeAtStart ? 'CROSSFADE AT END' : 'CROSSFADE AT START'}
          </button>
        ` : nothing}
        <button class="menu-item" @click=${() => this.onEditSample(side === 'b' ? 'b' : 'a')}>
          EDIT SAMPLE
        </button>
        ${showDisableDual ? html`
          <button class="menu-item" @click=${this.onToggleSplit}>
            DISABLE DUAL SAMPLE
          </button>
        ` : nothing}
      </div>
    `;
  }

  private renderPitchSubmenu() {
    const current = this.sample?.detectedNote ?? null;
    return html`
      <div class="submenu">
        <button class=${current === null ? 'selected' : ''} @click=${() => this.selectNote(null)}>None</button>
        ${ALL_NOTES.map(
          (note) => html`<button class=${current === note ? 'selected' : ''} @click=${() => this.selectNote(note)}>${note}</button>`,
        )}
      </div>
    `;
  }

  private startRename(target: 'main' | 'a' | 'b'): void {
    this.sampleMenuOpen = false;
    this.splitMenuOpen = false;
    this.splitMenuOpenB = false;
    this.pitchSubmenuOpen = false;
    this.renamingTarget = target;
    this.updateComplete.then(() => {
      const input = this.shadowRoot!.querySelector('.rename-input') as HTMLInputElement | null;
      if (input) {
        input.focus();
        input.select();
      }
    });
  }

  private commitRename(target: 'main' | 'a' | 'b', value: string): void {
    const trimmed = value.trim();
    if (!trimmed) {
      this.renamingTarget = null;
      return;
    }
    this.renamingTarget = null;
    if (target === 'b') {
      this.dispatchEvent(
        new CustomEvent('split-sample-rename', {
          detail: { index: this.index, name: trimmed },
          bubbles: true,
          composed: true,
        }),
      );
    } else {
      this.dispatchEvent(
        new CustomEvent('sample-rename', {
          detail: { index: this.index, name: trimmed },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  private onRenameKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitRename('main', (e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      this.renamingTarget = null;
    }
  }

  private onRenameBlur(e: FocusEvent): void {
    if (this.renamingTarget === 'main') {
      this.commitRename('main', (e.target as HTMLInputElement).value);
    }
  }

  private onRenameKeydownA(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitRename('a', (e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      this.renamingTarget = null;
    }
  }

  private onRenameBlurA(e: FocusEvent): void {
    if (this.renamingTarget === 'a') {
      this.commitRename('a', (e.target as HTMLInputElement).value);
    }
  }

  private onRenameKeydownB(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.commitRename('b', (e.target as HTMLInputElement).value);
    } else if (e.key === 'Escape') {
      this.renamingTarget = null;
    }
  }

  private onRenameBlurB(e: FocusEvent): void {
    if (this.renamingTarget === 'b') {
      this.commitRename('b', (e.target as HTMLInputElement).value);
    }
  }

  private selectNote(note: string | null): void {
    this.sampleMenuOpen = false;
    this.pitchSubmenuOpen = false;
    this.dispatchEvent(
      new CustomEvent('note-change', {
        detail: { index: this.index, note },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private get effectiveMaxDuration(): number {
    if (this.sample?.splitEnabled) {
      return getSplitMaxDuration(this.sample.lofi);
    }
    return this.sample
      ? getEffectiveMaxDuration(this.sample.lofi)
      : MAX_SAMPLE_DURATION;
  }

  private get splitMaxDuration(): number {
    return this.sample
      ? getSplitMaxDuration(this.sample.lofi)
      : MAX_SAMPLE_DURATION / 2;
  }

  private get lofiButtonClass(): string {
    if (!this.sample) return '';
    switch (this.sample.lofi) {
      case 'gxlofi': return 'gxlofi';
      case 'sxlofi': return 'sxlofi';
      case 'xlofi': return 'xlofi';
      case 'lofi': return 'active';
      default: return '';
    }
  }

  private get lofiButtonLabel(): string {
    if (!this.sample) return 'LO';
    switch (this.sample.lofi) {
      case 'gxlofi': return 'GX';
      case 'sxlofi': return 'SX';
      case 'xlofi': return 'XL';
      default: return 'LO';
    }
  }

  private get lofiButtonTitle(): string {
    if (!this.sample) return '';
    switch (this.sample.lofi) {
      case 'gxlofi': return 'Disable GXLOFI — click to return to normal (5s max)';
      case 'sxlofi': return this.extendedLofiModes
        ? 'Enable GXLOFI — 80s max, pitched up 4 octaves (1/16 sample rate)'
        : 'Disable SXLOFI — click to return to normal (5s max)';
      case 'xlofi': return this.extendedLofiModes
        ? 'Enable SXLOFI — 40s max, pitched up 3 octaves (1/8 sample rate)'
        : 'Disable XLOFI — click to return to normal (5s max)';
      case 'lofi': return 'Enable XLOFI — 20s max, pitched up 2 octaves (quarter sample rate)';
      default: return 'Enable LOFI — 10s max, pitched up 1 octave (half sample rate)';
    }
  }

  private get pitchDebugLabel(): string {
    if (!this.sample) return '';
    if (!this.sample.pitchDebug) return 'dbg:no-data';
    const debug = this.sample.pitchDebug;
    if (debug.rejectedReason) {
      return `dbg:${debug.rejectedReason}`;
    }
    return `dbg c${debug.avgClarity.toFixed(2)} z${debug.avgZcr.toFixed(2)}`;
  }

  private get pitchDebugTitle(): string {
    if (!this.sample) return '';
    if (!this.sample.pitchDebug) return 'No pitch diagnostics available for this sample. Re-import to regenerate diagnostics.';
    const debug = this.sample.pitchDebug;
    const freq = debug.detectedFrequency !== null ? `${debug.detectedFrequency.toFixed(1)}Hz` : 'n/a';
    const spread = debug.spreadRatio !== null ? debug.spreadRatio.toFixed(3) : 'n/a';
    return [
      `freq: ${freq}`,
      `note: ${debug.detectedNote ?? 'none'}`,
      `detections: ${debug.detections}`,
      `clarity: ${debug.avgClarity.toFixed(3)}`,
      `zcr: ${debug.avgZcr.toFixed(3)}`,
      `spread: ${spread}`,
      `rate: ${Math.round(debug.analysisRate)}Hz`,
      `factor: ${debug.downsampleFactor}`,
      `reason: ${debug.rejectedReason ?? 'accepted'}`,
    ].join(' · ');
  }

  private toggleLoop(): void {
    if (!this.sample) return;
    const effectiveMax = this.effectiveMaxDuration;
    const audioDuration = this.sample.audioBuffer.duration;
    const loopEnd = Math.min(audioDuration, effectiveMax);
    // Start at 10% to allow room for default 10% crossfade
    const loopStart = loopEnd * 0.1;
    const loopDuration = loopEnd - loopStart;
    const newLoop: LoopSettings | null = this.sample.loop
      ? null
      : {
          startTime: loopStart,
          endTime: loopEnd,
          crossfadeDuration: loopDuration * 0.1,
        };

    this.dispatchEvent(
      new CustomEvent('loop-update', {
        detail: { index: this.index, loop: newLoop },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleLoopB(): void {
    if (!this.sample?.splitSample) return;
    const splitMax = this.splitMaxDuration;
    const b = this.sample.splitSample;
    const audioDuration = b.audioBuffer.duration;
    const loopEnd = Math.min(audioDuration, splitMax);
    const loopStart = loopEnd * 0.1;
    const loopDuration = loopEnd - loopStart;
    const newLoop: LoopSettings | null = b.loop
      ? null
      : {
          startTime: loopStart,
          endTime: loopEnd,
          crossfadeDuration: loopDuration * 0.1,
        };

    this.dispatchEvent(
      new CustomEvent('split-loop-update', {
        detail: { index: this.index, loop: newLoop },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onLoopChangeB(e: CustomEvent<LoopSettings>): void {
    this.dispatchEvent(
      new CustomEvent('split-loop-update', {
        detail: { index: this.index, loop: e.detail },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onLoopChange(e: CustomEvent<LoopSettings>): void {
    this.dispatchEvent(
      new CustomEvent('loop-update', {
        detail: { index: this.index, loop: e.detail },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private toggleLofi(): void {
    if (!this.sample) return;
    this.stopPlayback();
    const nextMode = getNextLofiMode(this.sample.lofi, this.extendedLofiModes);
    this.dispatchEvent(
      new CustomEvent('lofi-toggle', {
        detail: { index: this.index, lofi: nextMode },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private togglePlay(): void {
    if (this.playing) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
  }

  private startPlayback(): void {
    if (!this.sample) return;

    // Stop any other playing sample
    window.dispatchEvent(new Event('stop-all-playback'));

    this.playing = true;
    const lofi = this.sample.lofi;

    if (this.sample.loop) {
      // Looped playback with crossfade — no auto-stop
      playSampleLooped(this.sample.audioBuffer, this.sample.loop, lofi).then((stop) => {
        this.stopFn = stop;
      });
    } else {
      this.stopFn = playSample(this.sample.audioBuffer, 0, lofi);
      // Auto-stop after effective duration
      const dur = Math.min(this.sample.duration, this.effectiveMaxDuration);
      this.playTimer = setTimeout(() => this.stopPlayback(), dur * 1000);
    }
  }

  private stopPlayback(): void {
    clearTimeout(this.playTimer);
    this.playTimer = undefined;
    this.stopFn?.();
    this.stopFn = undefined;
    this.playing = false;
  }

  private togglePlayB(): void {
    if (this.playingB) {
      this.stopPlaybackB();
    } else {
      this.startPlaybackB();
    }
  }

  private startPlaybackB(): void {
    if (!this.sample?.splitSample) return;

    // Stop any other playing sample
    window.dispatchEvent(new Event('stop-all-playback'));

    this.playingB = true;
    const lofi = this.sample.lofi;
    const b = this.sample.splitSample;

    if (b.loop) {
      playSampleLooped(b.audioBuffer, b.loop, lofi).then((stop) => {
        this.stopFnB = stop;
      });
    } else {
      this.stopFnB = playSample(b.audioBuffer, 0, lofi);
      const dur = Math.min(b.duration, this.splitMaxDuration);
      this.playTimerB = setTimeout(() => this.stopPlaybackB(), dur * 1000);
    }
  }

  private stopPlaybackB(): void {
    clearTimeout(this.playTimerB);
    this.playTimerB = undefined;
    this.stopFnB?.();
    this.stopFnB = undefined;
    this.playingB = false;
  }

  private onToggleSplit(): void {
    this.sampleMenuOpen = false;
    this.pitchSubmenuOpen = false;
    this.dispatchEvent(
      new CustomEvent('split-toggle', {
        detail: { index: this.index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onReverseSample(): void {
    this.sampleMenuOpen = false;
    this.splitMenuOpen = false;
    this.pitchSubmenuOpen = false;
    this.stopPlayback();
    this.dispatchEvent(
      new CustomEvent('sample-reverse', {
        detail: { index: this.index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onEditSample(side: 'main' | 'a' | 'b'): void {
    this.sampleMenuOpen = false;
    this.splitMenuOpen = false;
    this.splitMenuOpenB = false;
    this.pitchSubmenuOpen = false;
    this.stopPlayback();
    this.dispatchEvent(
      new CustomEvent('sample-edit', {
        detail: { index: this.index, side },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onReverseSplitSample(): void {
    this.splitMenuOpenB = false;
    this.stopPlaybackB();
    this.dispatchEvent(
      new CustomEvent('split-sample-reverse', {
        detail: { index: this.index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onToggleCrossfadePosition(target: 'main' | 'split'): void {
    this.sampleMenuOpen = false;
    this.splitMenuOpen = false;
    this.splitMenuOpenB = false;
    this.stopPlayback();
    if (target === 'split') this.stopPlaybackB();
    const eventName = target === 'split' ? 'split-crossfade-position-toggle' : 'crossfade-position-toggle';
    this.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { index: this.index },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onClickImportB(): void {
    if (!this.fileInputB) {
      this.fileInputB = this.shadowRoot!.querySelector('#file-input-b') as HTMLInputElement;
    }
    this.fileInputB?.click();
  }

  private onFileSelectedB(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      this.dispatchEvent(
        new CustomEvent('split-sample-import', {
          detail: { index: this.index, file },
          bubbles: true,
          composed: true,
        }),
      );
    }
    input.value = '';
  }

  // --- Split-mode Drag & Drop (per-half) ---
  // Handle three drop kinds on each half:
  //   1. Audio files / folders dropped from OS → sample-import (existing behavior)
  //   2. Half drag from another (or same) slot → content swap
  //   3. Main drag from a non-split slot → content swap
  // Main drag from a split slot is rejected (use the slot-number drop area instead).

  /** Returns the kind of incoming drag for a half drop-target. */
  private static halfDragKind(e: DragEvent): 'file' | 'sympakt' | null {
    const types = e.dataTransfer?.types;
    if (!types) return null;
    if (types.includes('Files')) return 'file';
    if (types.includes(MT_HALF) || types.includes(MT_MAIN_NONSPLIT)) return 'sympakt';
    return null;
  }

  private onHalfDragOver(side: 'a' | 'b', e: DragEvent): void {
    const kind = SampleSlot.halfDragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = kind === 'file' ? 'copy' : 'move';
    if (side === 'a') this.dragOverA = true;
    else this.dragOverB = true;
  }

  private onHalfDragLeave(side: 'a' | 'b', e: DragEvent): void {
    const flag = side === 'a' ? this.dragOverA : this.dragOverB;
    if (!flag) return;
    e.stopPropagation();
    if (side === 'a') this.dragOverA = false;
    else this.dragOverB = false;
  }

  private onHalfDrop(side: 'a' | 'b', e: DragEvent): void {
    const kind = SampleSlot.halfDragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.stopPropagation();
    if (side === 'a') this.dragOverA = false;
    else this.dragOverB = false;

    if (kind === 'file') {
      const files = e.dataTransfer!.files;
      if (!files || files.length === 0) return;
      const audioFile = Array.from(files).find(
        (f) => f.type.startsWith('audio/') || AUDIO_EXT_RE.test(f.name),
      );
      if (!audioFile) return;
      this.dispatchEvent(
        new CustomEvent(side === 'a' ? 'sample-import' : 'split-sample-import', {
          detail: { index: this.index, file: audioFile },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    const payload = SampleSlot.getDragPayload(e);
    if (payload) this.dispatchSwap(payload, side);
  }

  private onHalfDragStart(side: 'a' | 'b', e: DragEvent): void {
    // Refuse to initiate a drag from an empty / non-applicable half.
    if (side === 'a') {
      if (!this.sample?.splitEnabled || this.sample.aEmpty) {
        e.preventDefault();
        return;
      }
    } else {
      if (!this.sample?.splitSample) {
        e.preventDefault();
        return;
      }
    }
    e.stopPropagation();
    this.setHalfDragImage(e, e.currentTarget as HTMLElement);
    if (side === 'a') this.draggingA = true;
    else this.draggingB = true;
    this.setDragData(e, side);
  }

  private onHalfDragEnd(side: 'a' | 'b', e: DragEvent): void {
    e.stopPropagation();
    if (side === 'a') this.draggingA = false;
    else this.draggingB = false;
  }

  // Stable arrow-function wrappers so Lit's `class=` event bindings don't see a
  // new listener reference on each render.
  private onDragOverA = (e: DragEvent) => this.onHalfDragOver('a', e);
  private onDragOverB = (e: DragEvent) => this.onHalfDragOver('b', e);
  private onDragLeaveA = (e: DragEvent) => this.onHalfDragLeave('a', e);
  private onDragLeaveB = (e: DragEvent) => this.onHalfDragLeave('b', e);
  private onDropA = (e: DragEvent) => this.onHalfDrop('a', e);
  private onDropB = (e: DragEvent) => this.onHalfDrop('b', e);
  private onHalfDragStartA = (e: DragEvent) => this.onHalfDragStart('a', e);
  private onHalfDragStartB = (e: DragEvent) => this.onHalfDragStart('b', e);
  private onHalfDragEndA = (e: DragEvent) => this.onHalfDragEnd('a', e);
  private onHalfDragEndB = (e: DragEvent) => this.onHalfDragEnd('b', e);

  // --- Slot-number (whole-slot handle in split mode) ---

  private onNumberDragStart(e: DragEvent): void {
    if (!this.sample?.splitEnabled) {
      // Slot-number only initiates a drag in split mode (otherwise the
      // whole .slot is already the drag handle).
      e.preventDefault();
      return;
    }
    e.stopPropagation();
    // Use the full .slot element as the drag image so the dragged "ghost" shows
    // the whole row, not just the small slot-number span.
    const slot = this.shadowRoot?.querySelector('.slot') as HTMLElement | null;
    if (slot && e.dataTransfer) {
      const slotRect = slot.getBoundingClientRect();
      e.dataTransfer.setDragImage(
        slot,
        Math.max(0, e.clientX - slotRect.left),
        Math.max(0, e.clientY - slotRect.top),
      );
    }
    this.dragging = true;
    this.setDragData(e, 'main');
  }

  private onNumberDragEnd(e: DragEvent): void {
    e.stopPropagation();
    this.dragging = false;
  }

  private onNumberDragOver(e: DragEvent): void {
    const types = e.dataTransfer?.types;
    if (!types) return;
    // Slot-number only accepts whole-slot main drags (shift). Reject halves.
    if (types.includes(MT_MAIN_NONSPLIT) || types.includes(MT_MAIN_SPLIT)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = 'move';
      this.dragOverNumber = true;
      this.dragOver = true;
    }
  }

  private onNumberDragLeave(e: DragEvent): void {
    if (!this.dragOverNumber) return;
    e.stopPropagation();
    this.dragOverNumber = false;
    this.dragOver = false;
  }

  private onNumberDrop(e: DragEvent): void {
    const types = e.dataTransfer?.types;
    if (!types) return;
    if (!types.includes(MT_MAIN_NONSPLIT) && !types.includes(MT_MAIN_SPLIT)) return;
    e.preventDefault();
    e.stopPropagation();
    this.dragOverNumber = false;
    this.dragOver = false;

    const payload = SampleSlot.getDragPayload(e);
    if (payload && payload.side === 'main' && payload.index !== this.index) {
      this.dispatchEvent(
        new CustomEvent('sample-move', {
          detail: { from: payload.index, to: this.index },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }

  // --- Drag & Drop (whole non-split slot) ---

  private onDragStart(e: DragEvent): void {
    if (!this.sample || this.sample.splitEnabled) {
      e.preventDefault();
      return;
    }
    this.dragging = true;
    this.setDragData(e, 'main');
  }

  private onDragEnd(): void {
    this.dragging = false;
  }

  private onDragOver(e: DragEvent): void {
    const types = e.dataTransfer?.types;
    if (!types) return;
    if (types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      this.dragOver = true;
      return;
    }
    // Accept any sympakt drag on a non-split slot (main = shift, half = swap)
    if (
      types.includes(MT_MAIN_NONSPLIT) ||
      types.includes(MT_MAIN_SPLIT) ||
      types.includes(MT_HALF)
    ) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      this.dragOver = true;
    }
  }

  private onDragLeave(): void {
    this.dragOver = false;
  }

  private onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dragOver = false;

    // Check for directory or file drops via DataTransferItem entries
    const items = e.dataTransfer?.items;
    if (items && items.length > 0) {
      // Try to detect a folder drop using webkitGetAsEntry
      const entry = items[0].webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        this.handleFolderDrop(entry as FileSystemDirectoryEntry);
        return;
      }
    }

    // Check if it's a file drop
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      const audioFiles = Array.from(files).filter(
        (f) => f.type.startsWith('audio/') || AUDIO_EXT_RE.test(f.name),
      );
      if (audioFiles.length > 1) {
        // Multiple audio files dropped — treat as batch
        this.dispatchEvent(
          new CustomEvent('sample-import-batch', {
            detail: { index: this.index, files: audioFiles },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
      if (audioFiles.length === 1) {
        this.dispatchEvent(
          new CustomEvent('sample-import', {
            detail: { index: this.index, file: audioFiles[0] },
            bubbles: true,
            composed: true,
          }),
        );
        return;
      }
    }

    // Otherwise it's a sympakt reorder/swap drag
    const payload = SampleSlot.getDragPayload(e);
    if (payload) this.dispatchSwap(payload, 'main');
  }

  // --- Drag helpers ---

  private setDragData(e: DragEvent, side: 'main' | 'a' | 'b'): void {
    const dt = e.dataTransfer;
    if (!dt) return;
    dt.effectAllowed = 'move';
    dt.setData('text/plain', JSON.stringify({ index: this.index, side }));
    if (side === 'main') {
      const isSplit = this.sample?.splitEnabled ?? false;
      dt.setData(isSplit ? MT_MAIN_SPLIT : MT_MAIN_NONSPLIT, '1');
    } else {
      dt.setData(MT_HALF, '1');
    }
  }

  /**
   * Apply transient inline styling to the half so the browser-captured drag
   * snapshot has a visible border/background (giving it a "slot fragment" look).
   * Uses inline `style.*` properties because Lit's `class=` binding can race
   * with classList mutations and strip a temporarily-added class. Inline styles
   * are untouched by Lit and reliably persist for the snapshot.
   * The styles are cleared on the next tick — by then the browser has already
   * taken the snapshot.
   */
  private setHalfDragImage(e: DragEvent, half: HTMLElement | null): void {
    if (!half || !e.dataTransfer) return;
    // Snapshot original inline styles so we can restore them
    const orig = {
      background: half.style.background,
      border: half.style.border,
      borderLeft: half.style.borderLeft,
      borderRadius: half.style.borderRadius,
      padding: half.style.padding,
      paddingLeft: half.style.paddingLeft,
      marginLeft: half.style.marginLeft,
      boxShadow: half.style.boxShadow,
    };
    // Apply slot-fragment styling. We must explicitly override border-left /
    // padding-left / margin-left because `.split-half + .split-half` has the
    // same specificity and would otherwise keep the dashed vertical separator
    // when B is the drag source.
    half.style.background = 'var(--bg-slot)';
    half.style.border = '1px solid var(--accent)';
    half.style.borderLeft = '1px solid var(--accent)';
    half.style.borderRadius = '2px';
    half.style.padding = '4px 6px';
    half.style.paddingLeft = '6px';
    half.style.marginLeft = '0';
    half.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.5)';

    const rect = half.getBoundingClientRect();
    e.dataTransfer.setDragImage(
      half,
      Math.max(0, e.clientX - rect.left),
      Math.max(0, e.clientY - rect.top),
    );

    // Restore original styles on the next tick — the snapshot is taken
    // synchronously at the end of the dragstart handler, so by the time this
    // runs the bitmap already includes our temporary styling.
    setTimeout(() => {
      half.style.background = orig.background;
      half.style.border = orig.border;
      half.style.borderLeft = orig.borderLeft;
      half.style.borderRadius = orig.borderRadius;
      half.style.padding = orig.padding;
      half.style.paddingLeft = orig.paddingLeft;
      half.style.marginLeft = orig.marginLeft;
      half.style.boxShadow = orig.boxShadow;
    }, 0);
  }

  private static getDragPayload(e: DragEvent): { index: number; side: 'main' | 'a' | 'b' } | null {
    try {
      const text = e.dataTransfer?.getData('text/plain');
      if (!text) return null;
      const parsed = JSON.parse(text);
      if (
        typeof parsed?.index === 'number' &&
        (parsed.side === 'main' || parsed.side === 'a' || parsed.side === 'b')
      ) {
        return parsed;
      }
    } catch {
      // not JSON — ignore
    }
    return null;
  }

  /** Decide between sample-move (main→main shift) and sample-swap (content swap). */
  private dispatchSwap(from: { index: number; side: 'main' | 'a' | 'b' }, toSide: 'main' | 'a' | 'b'): void {
    if (from.index === this.index && from.side === toSide) return;
    if (from.side === 'main' && toSide === 'main') {
      this.dispatchEvent(
        new CustomEvent('sample-move', {
          detail: { from: from.index, to: this.index },
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }
    this.dispatchEvent(
      new CustomEvent('sample-swap', {
        detail: {
          fromIndex: from.index,
          fromSide: from.side,
          toIndex: this.index,
          toSide,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private async handleFolderDrop(dirEntry: FileSystemDirectoryEntry): Promise<void> {
    const files = await readAudioFilesFromDirectory(dirEntry);
    if (files.length > 0) {
      this.dispatchEvent(
        new CustomEvent('sample-import-batch', {
          detail: { index: this.index, files },
          bubbles: true,
          composed: true,
        }),
      );
    }
  }
}

function formatDuration(seconds: number): string {
  return seconds.toFixed(2) + 's';
}

const AUDIO_EXT_RE = /\.(wav|mp3|ogg|flac|aiff|m4a)$/i;

/** Read all audio files from a dropped directory entry, sorted by name.
 *  Applies the same exclusion logic as ZIP import:
 *  - skip macOS resource forks (._prefix, __MACOSX paths)
 *  - skip non-audio files
 *  - skip empty files
 */
async function readAudioFilesFromDirectory(dirEntry: FileSystemDirectoryEntry): Promise<File[]> {
  const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => {
    dirEntry.createReader().readEntries(resolve, reject);
  });

  const filtered = entries
    .filter((entry): entry is FileSystemFileEntry => {
      if (!entry.isFile) return false;
      if (!AUDIO_EXT_RE.test(entry.name)) return false;
      // Skip macOS resource fork files (._prefix)
      if (entry.name.startsWith('._')) return false;
      // Skip __MACOSX directory artifacts
      if (entry.fullPath.includes('__MACOSX/')) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const files = await Promise.all(
    filtered.map(
      (entry) =>
        new Promise<File>((resolve, reject) => {
          entry.file(resolve, reject);
        }),
    ),
  );

  // Skip empty files (same as ZIP import)
  return files.filter((f) => f.size > 0);
}

declare global {
  interface HTMLElementTagNameMap {
    'sp-sample-slot': SampleSlot;
  }
}
