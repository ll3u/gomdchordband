# GoMDChordBand

A Progressive Web App (PWA) designed to display chord sheets and canvas annotations on stage tablets and mobile phones during band rehearsals and live performances. The application is built to run entirely offline.

## Features

*   **Go-Based Deployment**: Packages all frontend assets (HTML, CSS, JS) into a single binary using the Go `embed` package.
*   **Chord Sheet Parsing**: Utilizes `ChordSheetJS` to render standard chord structures. Extensions or numeric modifiers (like `7`) are formatted as superscripts (`<sup>`) for better visibility.
*   **Security & Validation**: Integrates `DOMPurify` to sanitize HTML content before rendering track metadata or dynamically generated chord blocks.
*   **Typography**: Uses `Roboto Mono` as a fixed-width font to maintain spacing alignment, combined with an interactive slider to adjust font sizes per song.
*   **Transposition**: Supports live chord transposition based on the library's internal model, with automated conversion into German musical notation (`H` instead of `B`) and flat/sharp adjustments.
*   **Stage Tools**:
    *   **Screen Lock**: Uses the Screen Wake Lock API to prevent devices from dimming or going to sleep during use.
    *   **Fullscreen Mode**: Supports switching to browser fullscreen to utilize the entire screen area.
*   **Autoscroll**: Implements scrolling via `requestAnimationFrame` to match the native display refresh rate of the device. Includes a visual progress ring and auto-resets the viewport and zoom factor when changing tracks.
*   **Canvas Drawing**: Transparent drawing layer allowing touch-based sketches, notes, or highlights directly over the chord sheets, including an eraser tool.
*   **Mobile Interface**: A responsive bottom bar containing transposition, drawing tools, and speed settings that collapses into a drawer on smaller screens. The mobile song-list sidebar features an independent scroll area.
*   **Backup & Sync**: Tracks custom font sizes, canvas markers, transposed keys, and individual playback speeds in `localStorage`. Includes a JSON-based import/export option to copy these track configurations to other band devices.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/ll3u/gomdchordband
   cd gomdchordband
   ```
2. Set up the environment parameters in your terminal session:
   * **Windows PowerShell**:
     ```powershell
     \$env:BAND_GUARD_SECRET="YourSecureBandPassphrase123"
     \$env:ALLOW_CODE_GENERATION="true"
     ```
   * **Windows CMD**:
     ```cmd
     set BAND_GUARD_SECRET=YourSecureBandPassphrase123
     set ALLOW_CODE_GENERATION=true
     ```
   * **Linux / macOS / Git-Bash**:
     ```bash
     export BAND_GUARD_SECRET="YourSecureBandPassphrase123"
     export ALLOW_CODE_GENERATION="true"
     ```
3. Run the application:
   ```bash
   go run main.go
   ```
4. Configuration and Syncing:
   * Navigate to `http://localhost:8080/api/songs/import?get_code=true` to retrieve the system-derived secret code.
   * Open your Authenticator app (e.g., **Aegis** or **FreeOTP**) on the tablet, add a manual entry, set **Digits to 8**, **Period to 30s**, and paste the token.
   * Restart the Go server without `ALLOW_CODE_GENERATION` for secure standalone operation.

## Technical Stack

*   **Backend**: Go (Standard Library, Embedded Files)
*   **Frontend**: Vanilla JavaScript (ES6+), CSS3 (Strict CSP Separation without inline styles/scripts)
*   **Libraries**: `ChordSheetJS`, `DOMPurify`, `://github.com`
*   **Storage**: Browser LocalStorage for user preferences, file system state virtualization for backups.