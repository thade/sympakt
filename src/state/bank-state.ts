import { ReactiveController, ReactiveControllerHost } from 'lit';
import { Sample, MAX_SLOTS, getEffectiveMaxDuration, getSplitMaxDuration, createSentinelAudioBuffer } from '../types/index.js';
import type { LoopSettings, LofiMode, SplitSample, PitchDebugInfo } from '../types/index.js';
import { saveBank, loadBank, clearAll as clearPersistedData } from '../services/persistence.js';

type BankListener = () => void;

/** Source/target side for swap operations */
export type SwapSide = 'main' | 'a' | 'b';

/** Movable audio content (subset shared between Sample and SplitSample) */
interface SampleContent {
  name: string;
  originalFileName: string;
  audioBuffer: AudioBuffer;
  waveformData: number[];
  duration: number;
  originalFile: Uint8Array;
  loop: LoopSettings | null;
  detectedNote: string | null;
  pitchDebug?: PitchDebugInfo;
  reversed?: boolean;
}

/** True if the slot has content at the given side */
function hasContentAt(slot: Sample | null, side: SwapSide): boolean {
  if (!slot) return false;
  if (side === 'main' || side === 'a') {
    // In dual mode the A side can be flagged empty; in non-split mode the Sample
    // is the slot itself so it's always non-empty when slot is non-null.
    if (slot.splitEnabled && slot.aEmpty) return false;
    return true;
  }
  return slot.splitSample != null;
}

/** Extract movable audio content from a slot at the given side */
function extractContent(slot: Sample, side: SwapSide): SampleContent | null {
  if (side === 'main' || side === 'a') {
    if (slot.splitEnabled && slot.aEmpty) return null;
    return {
      name: slot.name,
      originalFileName: slot.originalFileName,
      audioBuffer: slot.audioBuffer,
      waveformData: slot.waveformData,
      duration: slot.duration,
      originalFile: slot.originalFile,
      loop: slot.loop,
      detectedNote: slot.detectedNote,
      pitchDebug: slot.pitchDebug,
      reversed: slot.reversed,
    };
  }
  const sb = slot.splitSample;
  if (!sb) return null;
  return {
    name: sb.name,
    originalFileName: sb.originalFileName,
    audioBuffer: sb.audioBuffer,
    waveformData: sb.waveformData,
    duration: sb.duration,
    originalFile: sb.originalFile,
    loop: sb.loop,
    detectedNote: sb.detectedNote,
    pitchDebug: sb.pitchDebug,
    reversed: sb.reversed,
  };
}

/** If a dual slot has both A empty (aEmpty) and B empty (no splitSample), null it out. */
function cleanupEmptyDual(slot: Sample | null): Sample | null {
  if (!slot) return null;
  if (slot.splitEnabled && slot.aEmpty && !slot.splitSample) return null;
  return slot;
}

/** Clamp a loop's duration to effectiveMax, also clamping crossfade to available source audio */
function clampLoop(
  loop: LoopSettings | null,
  audioDuration: number,
  effectiveMax: number,
): LoopSettings | null {
  if (!loop) return null;
  const loopLen = loop.endTime - loop.startTime;
  if (loopLen <= effectiveMax) return loop;
  const newEnd = Math.min(loop.startTime + effectiveMax, audioDuration);
  const maxCfSource = loop.crossfadeAtStart
    ? audioDuration - newEnd
    : loop.startTime;
  return {
    ...loop,
    endTime: newEnd,
    crossfadeDuration: Math.min(loop.crossfadeDuration, newEnd - loop.startTime, maxCfSource),
  };
}

/** Apply movable content into a slot at the given side, preserving slot config (lofi, splitEnabled).
 *  `sourceLofi` is used as the lofi of a freshly created non-split slot (when `slot` is null);
 *  it lets per-half drops onto an empty target preserve the source's lofi mode so its loop
 *  isn't unexpectedly clamped against a fresh 'off' max.
 */
function applyContent(
  slot: Sample | null,
  side: SwapSide,
  content: SampleContent | null,
  sourceLofi: LofiMode = 'off',
): Sample | null {
  if (side === 'main' || side === 'a') {
    if (!content) {
      // Emptying A: in dual mode, keep the slot but mark A as empty (sentinel audio fields).
      // In non-split mode, slot becomes null.
      if (slot?.splitEnabled) {
        return {
          ...slot,
          name: '',
          originalFileName: '',
          audioBuffer: createSentinelAudioBuffer(),
          waveformData: [],
          duration: 0,
          isTruncated: false,
          originalFile: new Uint8Array(0),
          loop: null,
          detectedNote: null,
          pitchDebug: undefined,
          reversed: undefined,
          aEmpty: true,
        };
      }
      return null;
    }
    if (slot) {
      const effectiveMax = slot.splitEnabled
        ? getSplitMaxDuration(slot.lofi)
        : getEffectiveMaxDuration(slot.lofi);
      const isTruncated = content.duration > effectiveMax;
      const loop = clampLoop(content.loop, content.audioBuffer.duration, effectiveMax);
      return {
        ...slot,
        name: content.name,
        originalFileName: content.originalFileName,
        audioBuffer: content.audioBuffer,
        waveformData: content.waveformData,
        duration: content.duration,
        originalFile: content.originalFile,
        loop,
        detectedNote: content.detectedNote,
        pitchDebug: content.pitchDebug,
        reversed: content.reversed,
        isTruncated,
        aEmpty: false,
      };
    }
    // New non-split slot from content — inherit lofi from the source so its loop length
    // and pitching expectations carry over.
    const effectiveMax = getEffectiveMaxDuration(sourceLofi);
    const isTruncated = content.duration > effectiveMax;
    const loop = clampLoop(content.loop, content.audioBuffer.duration, effectiveMax);
    return {
      id: crypto.randomUUID(),
      name: content.name,
      originalFileName: content.originalFileName,
      audioBuffer: content.audioBuffer,
      waveformData: content.waveformData,
      duration: content.duration,
      isTruncated,
      originalFile: content.originalFile,
      loop,
      lofi: sourceLofi,
      detectedNote: content.detectedNote,
      pitchDebug: content.pitchDebug,
      reversed: content.reversed,
    };
  }
  // side === 'b'
  if (!slot) return null;
  if (!content) {
    return { ...slot, splitSample: null };
  }
  const splitMax = getSplitMaxDuration(slot.lofi);
  const isTruncated = content.duration > splitMax;
  const loop = clampLoop(content.loop, content.audioBuffer.duration, splitMax);
  return {
    ...slot,
    splitSample: {
      name: content.name,
      originalFileName: content.originalFileName,
      audioBuffer: content.audioBuffer,
      waveformData: content.waveformData,
      duration: content.duration,
      isTruncated,
      originalFile: content.originalFile,
      loop,
      detectedNote: content.detectedNote,
      pitchDebug: content.pitchDebug,
      reversed: content.reversed,
    },
  };
}

/**
 * Reactive state store for the 64-slot sample bank.
 * Implements ReactiveController so Lit components can subscribe to changes.
 */
class BankStateStore {
  private slots: (Sample | null)[] = new Array(MAX_SLOTS).fill(null);
  private listeners = new Set<BankListener>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private _selectedIndex: number | null = null;
  private _selectedSide: 'a' | 'b' = 'a';

  /** Get the currently selected slot index */
  get selectedIndex(): number | null {
    return this._selectedIndex;
  }

  /** Side selected for keyboard preview when the selected slot is dual-split */
  get selectedSide(): 'a' | 'b' {
    return this._selectedSide;
  }

  /** Select a slot (null to deselect). Resets selectedSide to 'a'. */
  selectSlot(index: number | null): void {
    this._selectedIndex = index;
    this._selectedSide = 'a';
    this.notifyOnly();
  }

  /** Set which side (A or B) of a dual-split slot is targeted by keyboard preview */
  selectSide(side: 'a' | 'b'): void {
    if (this._selectedSide === side) return;
    this._selectedSide = side;
    this.notifyOnly();
  }

  /** Toggle the selected side between A and B */
  toggleSelectedSide(): void {
    this._selectedSide = this._selectedSide === 'a' ? 'b' : 'a';
    this.notifyOnly();
  }

  /** Get the currently selected sample */
  getSelectedSample(): Sample | null {
    if (this._selectedIndex === null) return null;
    return this.slots[this._selectedIndex] ?? null;
  }

  /**
   * Get the audio data (buffer, loop, lofi, duration) for the currently selected
   * side of the selected slot. Returns null when nothing is playable on that side
   * (e.g., A is empty in dual mode, or B isn't set).
   * If B is selected but missing, falls back to A when available.
   */
  getSelectedAudio(): {
    audioBuffer: AudioBuffer;
    loop: LoopSettings | null;
    lofi: LofiMode;
    duration: number;
  } | null {
    const sample = this.getSelectedSample();
    if (!sample) return null;
    if (sample.splitEnabled && this._selectedSide === 'b') {
      const b = sample.splitSample;
      if (b) {
        return {
          audioBuffer: b.audioBuffer,
          loop: b.loop,
          lofi: sample.lofi,
          duration: b.duration,
        };
      }
      // B selected but missing — fall through to A if available
    }
    if (sample.splitEnabled && sample.aEmpty) return null;
    return {
      audioBuffer: sample.audioBuffer,
      loop: sample.loop,
      lofi: sample.lofi,
      duration: sample.duration,
    };
  }

  /** Get a snapshot of all slots */
  getSlots(): ReadonlyArray<Sample | null> {
    return this.slots;
  }

  /** Get a single slot */
  getSlot(index: number): Sample | null {
    return this.slots[index] ?? null;
  }

  /** Set a sample in a slot */
  setSample(index: number, sample: Sample | null): void {
    if (index < 0 || index >= MAX_SLOTS) return;
    this.slots[index] = sample;
    this.notify();
  }

  /** Remove a sample from a slot */
  removeSample(index: number): void {
    this.setSample(index, null);
  }

  /** Update loop settings for a sample in a slot */
  updateSampleLoop(index: number, loop: LoopSettings | null): void {
    const sample = this.slots[index];
    if (!sample) return;
    this.slots[index] = { ...sample, loop };
    this.notify();
  }

  /** Toggle LOFI mode for a sample, recalculating truncation and clamping loop if needed */
  updateSampleLofi(index: number, lofi: LofiMode): void {
    const sample = this.slots[index];
    if (!sample) return;

    const effectiveMax = sample.splitEnabled
      ? getSplitMaxDuration(lofi)
      : getEffectiveMaxDuration(lofi);
    const isTruncated = sample.duration > effectiveMax;

    // When reducing effective max (e.g. xlofi→lofi, lofi→off), clamp loop duration if needed
    let loop = sample.loop;
    if (loop) {
      const loopLen = loop.endTime - loop.startTime;
      if (loopLen > effectiveMax) {
        const newEnd = Math.min(loop.startTime + effectiveMax, sample.audioBuffer.duration);
        const maxCfSource = loop.crossfadeAtStart
          ? sample.audioBuffer.duration - newEnd
          : loop.startTime;
        loop = {
          ...loop,
          endTime: newEnd,
          crossfadeDuration: Math.min(loop.crossfadeDuration, newEnd - loop.startTime, maxCfSource),
        };
      }
    }

    // Also clamp B sample loop if in split mode
    let splitSample = sample.splitSample;
    if (sample.splitEnabled && splitSample) {
      const splitMax = getSplitMaxDuration(lofi);
      const bTruncated = splitSample.duration > splitMax;
      let bLoop = splitSample.loop;
      if (bLoop) {
        const bLoopLen = bLoop.endTime - bLoop.startTime;
        if (bLoopLen > splitMax) {
          const newEnd = Math.min(bLoop.startTime + splitMax, splitSample.audioBuffer.duration);
          const bMaxCfSource = bLoop.crossfadeAtStart
            ? splitSample.audioBuffer.duration - newEnd
            : bLoop.startTime;
          bLoop = {
            ...bLoop,
            endTime: newEnd,
            crossfadeDuration: Math.min(bLoop.crossfadeDuration, newEnd - bLoop.startTime, bMaxCfSource),
          };
        }
      }
      splitSample = { ...splitSample, isTruncated: bTruncated, loop: bLoop };
    }

    this.slots[index] = { ...sample, lofi, isTruncated, loop, splitSample };
    this.notify();
  }

  /** Rename a sample */
  renameSample(index: number, name: string): void {
    const sample = this.slots[index];
    if (!sample) return;
    this.slots[index] = { ...sample, name };
    this.notify();
  }

  /** Rename the B-side sample in a dual split slot */
  renameSplitSample(index: number, name: string): void {
    const sample = this.slots[index];
    if (!sample?.splitSample) return;
    this.slots[index] = {
      ...sample,
      splitSample: { ...sample.splitSample, name },
    };
    this.notify();
  }

  /** Update the detected note for a sample (manual override or clear) */
  updateSampleNote(index: number, note: string | null): void {
    const sample = this.slots[index];
    if (!sample) return;
    this.slots[index] = { ...sample, detectedNote: note };
    this.notify();
  }

  /** Toggle dual split mode for a slot */
  toggleSplitMode(index: number): void {
    const sample = this.slots[index];
    if (!sample) return;
    const splitEnabled = !sample.splitEnabled;

    // Special case: disabling dual mode while A is empty.
    // Promote B to the new main Sample if it exists; otherwise the slot is empty.
    if (!splitEnabled && sample.aEmpty) {
      const b = sample.splitSample;
      if (!b) {
        this.slots[index] = null;
      } else {
        const effectiveMax = getEffectiveMaxDuration(sample.lofi);
        const isTruncated = b.duration > effectiveMax;
        const loop = clampLoop(b.loop, b.audioBuffer.duration, effectiveMax);
        this.slots[index] = {
          id: crypto.randomUUID(),
          name: b.name,
          originalFileName: b.originalFileName,
          audioBuffer: b.audioBuffer,
          waveformData: b.waveformData,
          duration: b.duration,
          isTruncated,
          originalFile: b.originalFile,
          loop,
          lofi: sample.lofi,
          detectedNote: b.detectedNote,
          pitchDebug: b.pitchDebug,
          reversed: b.reversed,
        };
      }
      this.notify();
      return;
    }

    const splitMaxDur = getSplitMaxDuration(sample.lofi);

    // Recalculate A sample truncation based on split max
    const isTruncated = splitEnabled
      ? sample.duration > splitMaxDur
      : sample.duration > getEffectiveMaxDuration(sample.lofi);

    // Clamp A loop if needed
    let loop = sample.loop;
    if (splitEnabled && loop) {
      const loopLen = loop.endTime - loop.startTime;
      if (loopLen > splitMaxDur) {
        const newEnd = Math.min(loop.startTime + splitMaxDur, sample.audioBuffer.duration);
        const maxCfSource = loop.crossfadeAtStart
          ? sample.audioBuffer.duration - newEnd
          : loop.startTime;
        loop = {
          ...loop,
          endTime: newEnd,
          crossfadeDuration: Math.min(loop.crossfadeDuration, newEnd - loop.startTime, maxCfSource),
        };
      }
    }

    this.slots[index] = {
      ...sample,
      splitEnabled,
      isTruncated,
      loop,
      // Discard B sample when disabling split
      splitSample: splitEnabled ? (sample.splitSample ?? null) : undefined,
    };
    this.notify();
  }

  /** Set the B-side sample in a dual split slot */
  setSplitSample(index: number, splitSample: SplitSample | null): void {
    const sample = this.slots[index];
    if (!sample || !sample.splitEnabled) return;
    this.slots[index] = { ...sample, splitSample };
    this.notify();
  }

  /** Update loop settings for the B-side sample */
  updateSplitSampleLoop(index: number, loop: LoopSettings | null): void {
    const sample = this.slots[index];
    if (!sample?.splitSample) return;
    this.slots[index] = {
      ...sample,
      splitSample: { ...sample.splitSample, loop },
    };
    this.notify();
  }

  /** Toggle crossfade position (at start vs at end) for a sample's loop */
  toggleCrossfadePosition(index: number): void {
    const sample = this.slots[index];
    if (!sample?.loop) return;
    const atStart = !sample.loop.crossfadeAtStart;
    // Clamp crossfade to available source audio in the new direction
    const maxCf = atStart
      ? sample.audioBuffer.duration - sample.loop.endTime  // post-end audio
      : sample.loop.startTime;                              // pre-start audio
    const loopLen = sample.loop.endTime - sample.loop.startTime;
    const crossfadeDuration = Math.min(sample.loop.crossfadeDuration, loopLen, maxCf);
    this.slots[index] = {
      ...sample,
      loop: { ...sample.loop, crossfadeAtStart: atStart, crossfadeDuration },
    };
    this.notify();
  }

  /** Toggle crossfade position for the B-side sample's loop */
  toggleSplitCrossfadePosition(index: number): void {
    const sample = this.slots[index];
    if (!sample?.splitSample?.loop) return;
    const split = sample.splitSample;
    const atStart = !split.loop!.crossfadeAtStart;
    const maxCf = atStart
      ? split.audioBuffer.duration - split.loop!.endTime
      : split.loop!.startTime;
    const loopLen = split.loop!.endTime - split.loop!.startTime;
    const crossfadeDuration = Math.min(split.loop!.crossfadeDuration, loopLen, maxCf);
    this.slots[index] = {
      ...sample,
      splitSample: {
        ...split,
        loop: { ...split.loop!, crossfadeAtStart: atStart, crossfadeDuration },
      },
    };
    this.notify();
  }

  /** Remove the B-side sample from a dual split slot */
  removeSplitSample(index: number): void {
    const sample = this.slots[index];
    if (!sample) return;
    this.slots[index] = cleanupEmptyDual({ ...sample, splitSample: null });
    this.notify();
  }

  /** Update the detected note for the B-side sample */
  updateSplitSampleNote(index: number, note: string | null): void {
    const sample = this.slots[index];
    if (!sample?.splitSample) return;
    this.slots[index] = {
      ...sample,
      splitSample: { ...sample.splitSample, detectedNote: note },
    };
    this.notify();
  }

  /** Clear pitch detection data from all samples */
  clearAllPitchData(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const sample = this.slots[i];
      if (sample && (sample.detectedNote !== null || sample.pitchDebug)) {
        this.slots[i] = { ...sample, detectedNote: null, pitchDebug: undefined };
      }
    }
    this.notify();
  }

  /** Reverse a sample's audio buffer and waveform data, toggling the reversed flag */
  reverseSample(index: number): void {
    const sample = this.slots[index];
    if (!sample) return;

    // Reverse the audio buffer channel data
    const buf = sample.audioBuffer;
    const newBuffer = new AudioBuffer({
      length: buf.length,
      numberOfChannels: buf.numberOfChannels,
      sampleRate: buf.sampleRate,
    });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const original = buf.getChannelData(c);
      const reversed = new Float32Array(original.length);
      for (let i = 0; i < original.length; i++) {
        reversed[i] = original[original.length - 1 - i];
      }
      newBuffer.copyToChannel(reversed, c);
    }

    // Reverse the waveform data
    const newWaveform = [...sample.waveformData].reverse();

    // Adjust loop points if present
    let loop = sample.loop;
    if (loop) {
      const duration = sample.duration;
      const newStart = duration - loop.endTime;
      const newEnd = duration - loop.startTime;
      const maxCfSource = loop.crossfadeAtStart
        ? duration - Math.min(duration, newEnd)
        : Math.max(0, newStart);
      loop = {
        ...loop,
        startTime: Math.max(0, newStart),
        endTime: Math.min(duration, newEnd),
        crossfadeDuration: Math.min(loop.crossfadeDuration, maxCfSource),
      };
    }

    this.slots[index] = {
      ...sample,
      audioBuffer: newBuffer,
      waveformData: newWaveform,
      loop,
      reversed: !sample.reversed,
    };
    this.notify();
  }

  /** Reverse the B-side sample's audio buffer and waveform data */
  reverseSplitSample(index: number): void {
    const sample = this.slots[index];
    if (!sample?.splitSample) return;
    const split = sample.splitSample;

    // Reverse the audio buffer channel data
    const buf = split.audioBuffer;
    const newBuffer = new AudioBuffer({
      length: buf.length,
      numberOfChannels: buf.numberOfChannels,
      sampleRate: buf.sampleRate,
    });
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const original = buf.getChannelData(c);
      const reversed = new Float32Array(original.length);
      for (let i = 0; i < original.length; i++) {
        reversed[i] = original[original.length - 1 - i];
      }
      newBuffer.copyToChannel(reversed, c);
    }

    // Reverse the waveform data
    const newWaveform = [...split.waveformData].reverse();

    // Adjust loop points if present
    let loop = split.loop;
    if (loop) {
      const duration = split.duration;
      const newStart = duration - loop.endTime;
      const newEnd = duration - loop.startTime;
      const maxCfSource = loop.crossfadeAtStart
        ? duration - Math.min(duration, newEnd)
        : Math.max(0, newStart);
      loop = {
        ...loop,
        startTime: Math.max(0, newStart),
        endTime: Math.min(duration, newEnd),
        crossfadeDuration: Math.min(loop.crossfadeDuration, maxCfSource),
      };
    }

    this.slots[index] = {
      ...sample,
      splitSample: {
        ...split,
        audioBuffer: newBuffer,
        waveformData: newWaveform,
        loop,
        reversed: !split.reversed,
      },
    };
    this.notify();
  }

  /** Move a sample from one slot to another, shifting others */
  moveSample(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    if (fromIndex < 0 || fromIndex >= MAX_SLOTS) return;
    if (toIndex < 0 || toIndex >= MAX_SLOTS) return;
    const sample = this.slots[fromIndex];
    this.slots.splice(fromIndex, 1);
    this.slots.splice(toIndex, 0, sample);
    this.notify();
  }

  /**
   * Swap audio content between two slot positions, identified by (index, side).
   * - side 'main': the whole non-split slot's sample, OR the A side of a split slot (treated as the slot's main sample).
   * - side 'a' / 'b': the A or B half of a dual split slot.
   *
   * Slot configuration (lofi, splitEnabled, id, the *other* split half) is preserved at each slot.
   * Loop and isTruncated are recomputed against the destination's effective max duration.
   *
   * In dual slot mode, A can become empty (marked via the `aEmpty` flag with sentinel audio fields).
   * If both A and B end up empty in the source dual slot, the slot is cleared to null.
   */
  swapSamples(
    fromIndex: number,
    fromSide: SwapSide,
    toIndex: number,
    toSide: SwapSide,
  ): void {
    if (fromIndex < 0 || fromIndex >= MAX_SLOTS) return;
    if (toIndex < 0 || toIndex >= MAX_SLOTS) return;
    if (fromIndex === toIndex && fromSide === toSide) return;

    const fromSlot = this.slots[fromIndex];
    const toSlot = this.slots[toIndex];

    // Source must have content at the chosen side
    if (!hasContentAt(fromSlot, fromSide)) return;

    const fromContent = extractContent(fromSlot!, fromSide);
    const toContent = toSlot ? extractContent(toSlot, toSide) : null;

    // Carry the source slot's lofi so a brand-new destination slot (created
    // when dropping content into an empty slot) inherits a sensible playback
    // mode instead of always falling back to 'off'.
    const fromLofi = fromSlot!.lofi;
    const toLofi = toSlot?.lofi ?? 'off';

    if (fromIndex === toIndex) {
      // Same slot: apply both swaps sequentially (no new-slot creation path hit)
      let updated = applyContent(fromSlot, fromSide, toContent);
      updated = applyContent(updated, toSide, fromContent);
      this.slots[fromIndex] = cleanupEmptyDual(updated);
    } else {
      this.slots[fromIndex] = cleanupEmptyDual(applyContent(fromSlot, fromSide, toContent, toLofi));
      this.slots[toIndex] = cleanupEmptyDual(applyContent(toSlot, toSide, fromContent, fromLofi));
    }
    this.notify();
  }

  /** Clear the whole bank and persisted data */
  clearAll(): void {
    this.slots = new Array(MAX_SLOTS).fill(null);
    clearPersistedData().catch((err) => console.warn('Failed to clear persisted data:', err));
    this.notify();
  }

  /** Load a full bank (e.g. from imported ZIP) */
  loadBank(slots: (Sample | null)[]): void {
    this.slots = slots.slice(0, MAX_SLOTS);
    while (this.slots.length < MAX_SLOTS) {
      this.slots.push(null);
    }
    this.notify();
  }

  subscribe(listener: BankListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Restore bank state from IndexedDB. Returns true if data was found.
   */
  async restoreFromDB(): Promise<boolean> {
    try {
      const slots = await loadBank();
      if (slots) {
        this.slots = slots;
        this.notifyOnly();
        return true;
      }
    } catch (err) {
      console.warn('Failed to restore bank from IndexedDB:', err);
    }
    return false;
  }

  /** Notify listeners without triggering a save (used during restore) */
  private notifyOnly(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private notify(): void {
    this.notifyOnly();
    this.debouncedSave();
  }

  private debouncedSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      saveBank(this.slots).catch((err) =>
        console.warn('Failed to persist bank state:', err),
      );
    }, 500);
  }
}

/** Singleton state store */
export const bankState = new BankStateStore();

/**
 * Lit ReactiveController that triggers host updates when bank state changes.
 */
export class BankStateController implements ReactiveController {
  private unsubscribe?: () => void;

  constructor(private host: ReactiveControllerHost) {
    this.host.addController(this);
  }

  hostConnected(): void {
    this.unsubscribe = bankState.subscribe(() => {
      this.host.requestUpdate();
    });
  }

  hostDisconnected(): void {
    this.unsubscribe?.();
  }

  get slots(): ReadonlyArray<Sample | null> {
    return bankState.getSlots();
  }
}
