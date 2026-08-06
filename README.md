<div align="center">

<img src="./docs/images/sympakt-logo.png" alt="" align="center" height="42" />

# Sympakt

**Sample Pack Manager for the Elektron Syntakt**

[![Elektron Syntakt](https://img.shields.io/badge/Elektron-Syntakt-E84142?style=flat-square&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNTAgMTUwIj48cGF0aCBkPSJNNC45IDEyNC44TDI1LjEgMjVIMTQ1bC0yMSA5OS43LTExOS4xLjF6TTM2IDM2LjNsLTE2IDc3LjNoOTEuOGw0LjgtMjEuOWgtNDRsNTQtNTUuNEgzNnoiIGZpbGwtcnVsZT0iZXZlbm9kZCIgY2xpcC1ydWxlPSJldmVub2RkIiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==)](https://www.elektron.se/syntakt)
[![Lit](https://img.shields.io/badge/Lit-%23324FFF.svg?style=flat-square&logo=lit&logoColor=white)](https://lit.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-%23007ACC?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-44CC11?style=flat-square)](LICENSE)

[Features](#features) · [Usage](#usage) · [Export Format](#export-format) · [Development](#development)

⭐ If you find this useful, give it a star on GitHub!

</div>

![Screenshot of the Sympakt app in action](./docs/images/screenshot.png)

Create, preview, and export 64-slot sample banks for the [Elektron Syntakt](https://www.elektron.se/syntakt), entirely from your browser.

## Features

- **64-slot sample bank** — drag-and-drop grid with instant audio preview, auto-conversion to Syntakt format (16-bit, 48 kHz, mono), and ZIP import/export with metadata
- **Loop editing with crossfade** — interactive waveform overlay with zero-crossing snap, adjustable crossfade for click-free seamless loops
- **LOFI / XLOFI / SXLOFI / GXLOFI mode** — extends max sample time to 10s, 20s, 40s, or 80s by exporting pitched up, with bandwidth-accurate preview
- **Dual sample mode** — pack two samples into one slot (A+B); doubles your sample count within the 64-slot limit
- **Built-in sample editor** — trim, fade, reverse, normalize, bit crusher,  filter, and slice samples without leaving the app
- **Virtual keyboard** — 2-octave chromatic keyboard to audition samples at different pitches
- **Fully offline & private** — single self-contained HTML file, zero backend, session auto-saved in browser
- **Direct Syntakt upload research** — an experimental protocol integration is being validated against real hardware before release

## Usage

**Try Sympakt online → https://sinedied.github.io/sympakt/**

- **Import samples** — drag audio files onto any slot, or click the **+** button to browse
- **Reorder** — drag slots to rearrange the bank. In **dual sample mode**, drag the slot number to move the whole slot, or drag the A or B half to swap that specific sample with any other slot (regular or another A/B half).
- **Preview** — click the play button on any slot to hear the sample
- **Loop** — click the loop button to enable loop mode; drag the green handles to set loop points and the blue diamond to adjust crossfade. Right-click the sample name to toggle between **crossfade at end** (default) and **crossfade at start**
- **LOFI / XLOFI** — click **LO** to cycle through LOFI modes: off → LOFI (10s max, 2× speed) → XLOFI (20s max, 4× speed). Enable "Extended LOFI modes" in settings to add SXLOFI (40s max, 8× speed) and GXLOFI (80s max, 16× speed) to the cycle. On the Syntakt, pitch the sample down accordingly to hear the original sound.
- **Remove** — click the × button to clear a slot (requires confirmation)
- **Rename** — click a sample name and choose **RENAME** to edit the display name inline. Press Enter to confirm or Escape to cancel. Works in both normal and dual split modes.
- **Dual sample mode** — click a sample name and choose **ENABLE DUAL SAMPLE** to split the slot into A and B halves. Drop or click to import a sample into each half. Each side has its own waveform, loop points, and playback controls. LOFI and delete affect the whole slot. To revert to single mode, click the A-side name and choose **DISABLE DUAL SAMPLE**.

  **On the Syntakt**: sample A is accessible at the regular slot position (1–64). To play sample B, set the playback direction to **reverse** — B is stored reversed at the end of the WAV, so reversing it plays the original sound. Use a short **decay** or **sample length** to isolate the half you want to hear, since both samples share the same WAV file.

- **Reverse** — click a sample name and choose **REVERSE** to reverse the audio. The waveform updates to show the reversed audio. Click **REVERSE** again to undo. Works in dual split mode too (per-side).
- **Sample editor** — click a sample name and choose **EDIT SAMPLE** to open a destructive sample editor modal. Features:
  - **Trim** — drag white handles on the waveform to set start/end points
  - **Fade in/out** — drag the blue flag handles to add linear fades, with real-time waveform visualization
  - **Utility** — reverse, peak-normalize, and gain adjustment (waveform updates live)
  - **FX** — sample rate reduction (lo-fi crunch), bit depth reduction, and LP/HP/BP filter with adjustable cutoff and resonance
  - **Slicer** — split samples using transient detection, even spacing (powers of 2), or manual click-to-place markers. Preview individual slices with ◀/▶ navigation. Export slices to bank slots (optionally packed two-per-slot as dual A|B to halve the slot footprint) or download as a ZIP
  - Click **Apply** to save changes (editor stays open for further edits) or **Close** to exit (confirms if unapplied changes exist)
  - Toggle between centered and full-screen layout with the expand button
- **Import a pack** — click **Import .zip** to load a previously exported sample pack
- **Export** — click **Export .zip**, set a pack name, toggle normalization, and optionally include original files
- **Virtual keyboard** — press **P** or click the keyboard icon to show a 2-octave piano; click a sample slot to select it, then play it chromatically using the on-screen keys or QWERTY shortcuts (A–J for white keys, W/E/T/Y/U for sharps). Use **←/→** to shift the octave range and **↑/↓** to switch between samples. For dual-split slots, an **A | B** toggle appears in the keyboard bar — click it or press **Tab** to switch which side is played.
- **Max columns** — open **Settings** (gear icon) to adjust the max number of columns in the bank grid (1–4). The layout remains responsive within the chosen limit.
- **Alternate colors** — enable in **Settings** to switch to a colorblind-friendly blue/yellow/pink palette.

### Import from ZIP

When importing a `.zip` file, Sympakt looks for:
- WAV files named `NN_name.wav` (where NN is the slot number)
- A `sympakt.json` file for sample metadata
- An `originals/` folder with source files (if they were included during export)

## Export Format

Exported `.zip` files contain:

| Path | Description |
|------|-------------|
| `01_kick_C3.wav` … `64_pad.wav` | 16-bit, 48 kHz, mono WAV files (note appended to name if detected) |
| `01_kick-snare_DUAL.wav` | Dual sample slot: A in first half, B reversed in second half |
| `sympakt.json` | Pack name, slot mappings, durations, loop settings, original filenames |
| `originals/` *(optional)* | Original source files, if "Include originals" is checked |

### Truncation

Non-looped samples longer than 5s are automatically truncated on export. LOFI raises the limit to 10s, XLOFI to 20s, SXLOFI to 40s, GXLOFI to 80s. Looped samples export only the selected loop region with crossfade applied.

### LOFI / XLOFI / SXLOFI / GXLOFI

LOFI samples are exported at 2× speed — pitch down one octave on the Syntakt to hear the original sound. XLOFI exports at 4× speed (two octaves down), SXLOFI at 8× (three octaves down), GXLOFI at 16× (four octaves down). SXLOFI and GXLOFI are available when "Extended LOFI modes" is enabled in settings.

### Dual Samples

Exported as a single WAV: A in the first half, B reversed in the second half, separated by 20ms of silence. Max duration per side: 2.49s (normal), 4.99s (LOFI), 9.99s (XLOFI), 19.99s (SXLOFI), 39.99s (GXLOFI).

### Normalization

Samples are peak-normalized by default. You can disable this in the export dialog.

### Direct Syntakt Upload

Use **Connect Syntakt** in the toolbar to choose a USB MIDI input/output pair, then identify and inspect a connected device. The verified session stays active when the inspector is closed, until **Disconnect** is selected there. On Chromium over HTTPS or localhost, the main-toolbar **Import Syntakt** button reads all 64 global-library positions sequentially into the browser bank; it never writes to the device, but it does replace the current local bank after confirmation. While reading, it becomes **Cancel Syntakt import**. Cancellation disconnects Sympakt’s MIDI session defensively, so reconnect before the next device operation. A verified OS 1.40 empty library position is imported as an empty browser slot; any other rejected or malformed position, cancellation, or local bank change during reading stops the replacement and preserves the existing browser bank. Sympakt keeps each device sample as 16-bit / 48 kHz mono data so it can be edited or exported normally afterwards.

**Export to Syntakt** is enabled after a verified Syntakt connection and inventory inspection. It writes each occupied Sympakt bank slot only to the same-numbered Syntakt slot, after a deliberate overwrite acknowledgement and a user-selected local folder for durable WAV backups before the first device write. Before each writer opens, an exclusive MIDI operation re-identifies the device, checks inventory, and downloads the target again for an exact comparison with its backup. Readback verification is enabled by default and compares device PCM after every write; it may be explicitly unticked for a faster transfer. A completed write with readback unticked is still shown as successful, but unverified. Every backup run uses one strict `sympakt-syntakt-transfer` manifest, closed and revalidated after every transition; its legal sequential crash states are `backed-up* planned*`, `verified* (written|write-started)? backed-up*`, or `written* write-started? backed-up*`. Use **Recover backup run** after an interruption: recovery preflights the entire run and writes only where the live slot still matches the recorded intended upload. Empty device targets are rejected before the backup-folder chooser because restore-to-empty has not been validated yet. Files with another manifest format are rejected for automatic recovery and their WAV files are left untouched. The current OS 1.40 development matrix has passed a real Chromium/Web MIDI single-slot backup, upload, readback, restore, and independent checksum comparison.

## Development

### Prerequisites

- [Node.js](https://nodejs.org/) 24 or later

### Install & Run

```bash
git clone https://github.com/sinedied/sympakt.git
cd sympakt
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Build for Production

```bash
npm run build
npm run preview   # preview the production build locally
```

The build outputs a single `index.html` in `dist/` with all JS, CSS, fonts, and the favicon inlined. You can open it directly in any browser — no server needed.
