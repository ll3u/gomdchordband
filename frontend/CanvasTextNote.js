/*!
 * CanvasTextNote — tiny vanilla JS lib for dropping short text notes
 * onto a <canvas>
 * Usage:
 *   const tool = new CanvasTextNote(document.getElementById('sheet'), {
 *     fontFamily: 'serif',
 *     fontSize: 20,
 *     color: '#111111'
 *   });
 *   addNoteBtn.addEventListener('click', () => tool.activate());
 */
(function (global) {
  'use strict';

  function el(tag, style, attrs) {
    const e = document.createElement(tag);
    if (style) Object.assign(e.style, style);
    if (attrs) Object.keys(attrs).forEach(k => e.setAttribute(k, attrs[k]));
    return e;
  }

  function stop(e) { e.stopPropagation(); }

  class CanvasTextNote {
    constructor(canvas, options) {
      options = options || {};
      this.canvas = canvas;
      this.fontFamily = options.fontFamily || 'sans-serif';
      this.fontSize = options.fontSize || 20;
      this.minFontSize = options.minFontSize || 10;
      this.maxFontSize = options.maxFontSize || 64;
      this.fontStep = options.fontStep || 2;
      this.color = options.color || '#111111';
      this.onBurn = typeof options.onBurn === 'function' ? options.onBurn : null;
      this.onCancel = typeof options.onCancel === 'function' ? options.onCancel : null;

      // Where overlay elements (marker/preview) get positioned. Defaults to
      // the canvas's existing parent — pass `container` explicitly if your
      // canvas isn't sitting inside the element you want used as the
      // coordinate space (e.g. a wrapper that also holds the rendered song).
      this.container = options.container || canvas.parentElement;

      // If your app already manages the canvas's pixel size / DPR scaling
      // (e.g. resizing it to match a rendered song), set this to false so
      // this library never touches canvas.width/height itself.
      this.manageCanvasSize = options.manageCanvasSize !== false;

      // Where the fixed input bar mounts, and how far from the top it sits
      // (useful if you already have a fixed header/toolbar of your own).
      this.barContainer = options.barContainer || document.body;
      this.barTopOffset = options.barTopOffset || 0;

      // If your canvas/wrapper is pinch-zoomed via a CSS transform: scale(),
      // pass a function returning the current scale so the default
      // placement point lands in the right spot. Defaults to no zoom.
      this.getScale = typeof options.getScale === 'function' ? options.getScale : () => 1;

      // Element whose visible area is used to compute the default note
      // position (the "currently visible" area of a scrollable sheet).
      // Defaults to a #scroll-container element if present, else the window.
      this.viewport = options.viewport || document.getElementById('scroll-container') || null;

      this.note = null; // { x, y, marker, preview, bar, input } while placing

      this._setupStage();
      if (this.manageCanvasSize) {
        this._fitCanvasToCSSSize();
        this._onWindowResize = () => this._fitCanvasToCSSSize();
        window.addEventListener('resize', this._onWindowResize);
      }
    }

    // ---- public API ----------------------------------------------------

    // Places a new note marker at a sensible default position (the center
    // of whatever's currently visible) and opens the input bar.
    activate() {
      if (this.note) return; // one at a time
      const { x, y } = this._defaultPlacementPoint();
      this._startPlacing(x, y);
    }

    // Cancels the note currently being placed, if any.
    deactivate() {
      this._cancelCurrentNote();
    }

    isPlacing() { return !!this.note; }

    setStyle(style) {
      style = style || {};
      if (style.fontFamily) this.fontFamily = style.fontFamily;
      if (style.fontSize) this.fontSize = style.fontSize;
      if (style.color) this.color = style.color;
    }

    clearCanvas() {
      const ctx = this.canvas.getContext('2d');
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.restore();
    }

    // Call this yourself whenever the canvas's CSS size changes (e.g. after
    // re-rendering the song at a new size) if manageCanvasSize is false,
    // or if you just want to force a re-fit on demand.
    fitCanvasToCSSSize() {
      this._fitCanvasToCSSSize();
    }

    destroy() {
      this._cancelCurrentNote();
      if (this._onWindowResize) window.removeEventListener('resize', this._onWindowResize);
    }

    // ---- internal: stage / canvas setup --------------------------------

    _setupStage() {
      const stage = this.container;

      // The overlay (marker/preview) is positioned absolutely relative to
      // this element, same as your annotation canvas presumably already is.
      // Only touch position if it's not already a positioning context —
      // never override position:absolute/fixed that might already be set.
      const computedPosition = window.getComputedStyle(stage).position;
      if (computedPosition === 'static') {
        stage.style.position = 'relative';
      }

      this.stage = stage;
    }

    // Computes a default marker position: the center of whatever's
    // currently visible within `this.viewport` (or the window), converted
    // into the stage's local, unscaled coordinate space — the same
    // convention as a getCoords()-style helper that divides by zoom scale.
    _defaultPlacementPoint() {
      const stageRect = this.stage.getBoundingClientRect();
      const viewportRect = this.viewport
        ? this.viewport.getBoundingClientRect()
        : { top: 0, left: 0, right: window.innerWidth, bottom: window.innerHeight };

      const visTop = Math.max(stageRect.top, viewportRect.top, 0);
      const visBottom = Math.min(stageRect.bottom, viewportRect.bottom, window.innerHeight);
      const visLeft = Math.max(stageRect.left, viewportRect.left, 0);
      const visRight = Math.min(stageRect.right, viewportRect.right, window.innerWidth);

      const clientX = (visLeft + visRight) / 2;
      const clientY = (visTop + visBottom) / 2;
      const scale = this.getScale() || 1;

      return {
        x: (clientX - stageRect.left) / scale,
        y: (clientY - stageRect.top) / scale
      };
    }

    _fitCanvasToCSSSize() {
      const canvas = this.canvas;
      const cssW = canvas.clientWidth || parseInt(canvas.style.width) || canvas.width || 300;
      const cssH = canvas.clientHeight || parseInt(canvas.style.height) || canvas.height || 150;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.round(cssW * dpr);
      const targetH = Math.round(cssH * dpr);
      if (canvas.width === targetW && canvas.height === targetH) { this.dpr = dpr; return; }

      let snapshot = null;
      if (canvas.width > 0 && canvas.height > 0) {
        snapshot = document.createElement('canvas');
        snapshot.width = canvas.width;
        snapshot.height = canvas.height;
        snapshot.getContext('2d').drawImage(canvas, 0, 0);
      }

      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';

      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (snapshot) ctx.drawImage(snapshot, 0, 0, snapshot.width, snapshot.height, 0, 0, cssW, cssH);
      this.dpr = dpr;
    }

    // ---- internal: placing a note --------------------------------------

    _startPlacing(x, y) {
      // --- marker: small draggable dot at the tap point ---
      const marker = el('div', {
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        width: '22px',
        height: '22px',
        marginLeft: '-9px',
        marginTop: '-9px',
        borderRadius: '50%',
        background: 'rgba(30,144,255,0.85)',
        border: '2px solid #fff',
        boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
        zIndex: '1000',
        cursor: 'grab'
      });

      // --- ghost preview: shows exactly where the text will land ---
      const preview = el('div', {
        position: 'absolute',
        left: x + 'px',
        top: y + 'px',
        transform: 'translate(16px, -50%)',
        whiteSpace: 'pre',
        pointerEvents: 'none',
        fontFamily: this.fontFamily,
        fontSize: this.fontSize + 'px',
        color: this.color,
        opacity: '0.85',
        textShadow: '0 0 1px #999, 0 0 2px #999, 0 0 3px #999',
        zIndex: '999'
      });

      this.stage.appendChild(preview);
      this.stage.appendChild(marker);

      // --- fixed bar pinned to the TOP of the viewport (or your container) ---
      const bar = el('div', {});

      const btnBase = {}

      const cancelBtn = el('button', Object.assign({}, btnBase, { }));
      cancelBtn.type = 'button';
      cancelBtn.setAttribute('aria-label', 'Cancel');
      cancelBtn.innerHTML = `
        <svg class="mdi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path d="M0 0h24v24H0z" fill="none" />
          <path fill="currentColor" d="M12 22c-4.714 0-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12s0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22" opacity=".5" />
          <path fill="currentColor" d="M8.97 8.97a.75.75 0 0 1 1.06 0L12 10.94l1.97-1.97a.75.75 0 1 1 1.06 1.06L13.06 12l1.97 1.97a.75.75 0 1 1-1.06 1.06L12 13.06l-1.97 1.97a.75.75 0 0 1-1.06-1.06L10.94 12l-1.97-1.97a.75.75 0 0 1 0-1.06" />
        </svg>
      `;
      cancelBtn.classList.add('btn-tool', 'cancel'); 

      const minusBtn = el('button', Object.assign({}, btnBase, {  }));
      minusBtn.type = 'button';
      minusBtn.setAttribute('aria-label', 'Smaller text');
      minusBtn.innerHTML = `
        <svg class="mdi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path d="M0 0h24v24H0z" fill="none" />
          <path fill="currentColor" fill-rule="evenodd" d="M17.82 19.7c-.09-1.094.816-2.008 1.9-1.918c.189.016.414.085.643.154l.067.02l.06.018c.21.064.42.127.58.213a1.786 1.786 0 0 1 .637 2.549c-.1.152-.255.308-.41.464l-.045.045l-.044.045c-.155.157-.31.313-.46.414a1.754 1.754 0 0 1-2.527-.643c-.086-.161-.148-.373-.211-.585l-.018-.06l-.02-.068c-.07-.231-.137-.458-.152-.648" clip-rule="evenodd" />
          <path fill="currentColor" d="M11.157 20.313a9.157 9.157 0 1 0 0-18.313a9.157 9.157 0 0 0 0 18.313" opacity=".5" />
          <path fill="currentColor" fill-rule="evenodd" d="M8.023 11.157c0-.4.324-.723.723-.723h4.82a.723.723 0 1 1 0 1.445h-4.82a.723.723 0 0 1-.723-.723" clip-rule="evenodd" />
        </svg>
      `;
      minusBtn.classList.add('btn-tool'); 

      const plusBtn = el('button', Object.assign({}, btnBase, {  }));
      plusBtn.type = 'button';
      plusBtn.setAttribute('aria-label', 'Bigger text');
      plusBtn.innerHTML = `
        <svg class="mdi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path d="M0 0h24v24H0z" fill="none" />
          <path fill="currentColor" fill-rule="evenodd" d="M17.82 19.7c-.09-1.094.816-2.008 1.9-1.918c.189.016.414.085.643.154l.067.02l.06.018c.21.064.42.127.58.213a1.786 1.786 0 0 1 .637 2.549c-.1.152-.255.308-.41.464l-.045.045l-.044.045c-.155.157-.31.313-.46.414a1.754 1.754 0 0 1-2.527-.643c-.086-.161-.148-.373-.211-.585l-.018-.06l-.02-.068c-.07-.231-.137-.458-.152-.648" clip-rule="evenodd" />
          <path fill="currentColor" d="M11.157 20.313a9.157 9.157 0 1 0 0-18.313a9.157 9.157 0 0 0 0 18.313" opacity=".5" />
          <path fill="currentColor" fill-rule="evenodd" d="M11.156 8.024c.4 0 .723.324.723.723v1.687h1.687a.723.723 0 1 1 0 1.446h-1.687v1.687a.723.723 0 0 1-1.446 0V11.88H8.746a.723.723 0 1 1 0-1.446h1.687V8.747c0-.399.324-.723.723-.723" clip-rule="evenodd" />
        </svg>
      `;
      plusBtn.classList.add('btn-tool'); 

      const input = el('input', {
        flex: '1 1 auto',
        minWidth: '0',
        font: '16px Architects Daughter', // 16px avoids iOS auto-zoom-on-focus
        padding: '8px 10px',
        border: '0px solid #ccc',
        borderRadius: '6px',
        outline: 'none',
        background: '#2f3542',
        color: '#ffffff'
      });
      input.type = 'text';
      input.setAttribute('placeholder', 'note …');
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('autocapitalize', 'sentences');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('enterkeyhint', 'done');

      const confirmBtn = el('button', Object.assign({}, btnBase, { }));
      confirmBtn.type = 'button';
      confirmBtn.setAttribute('aria-label', 'Confirm and place note');
      confirmBtn.innerHTML = `
        <svg class="mdi-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
          <path d="M0 0h24v24H0z" fill="none" />
          <path fill="currentColor" d="M12 22c-4.714 0-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12s0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22" opacity=".5" />
          <path fill="currentColor" d="M16.03 8.97a.75.75 0 0 1 0 1.06l-5 5a.75.75 0 0 1-1.06 0l-2-2a.75.75 0 1 1 1.06-1.06l1.47 1.47l4.47-4.47a.75.75 0 0 1 1.06 0" />
        </svg>
      `;
      confirmBtn.classList.add('btn-tool', 'confirm'); 

      const form = el('form', { display: 'flex', flex: '1 1 auto', gap: '6px', alignItems: 'center', minWidth: '0' });
      form.appendChild(input);

      bar.appendChild(cancelBtn);
      bar.appendChild(minusBtn);
      bar.appendChild(form);
      bar.appendChild(plusBtn);
      bar.appendChild(confirmBtn);
      
      bar.setAttribute('id', 'ctn-wrapper');
      this.barContainer.appendChild(bar);

      const note = { x, y, marker, preview, bar, input };
      this.note = note;

      // Focus synchronously, inside this gesture's call stack, so the
      // on-screen keyboard reliably appears on iOS/Android.
      input.focus();

      // Live preview as the user types.
      input.addEventListener('input', () => { preview.textContent = input.value; });

      // Submitting the form (Enter / mobile keyboard "Done") confirms.
      form.addEventListener('submit', (e) => { e.preventDefault(); this._burnCurrentNote(); });

      minusBtn.addEventListener('click', () => this._stepFontSize(-this.fontStep));
      plusBtn.addEventListener('click', () => this._stepFontSize(this.fontStep));
      confirmBtn.addEventListener('click', () => this._burnCurrentNote());
      cancelBtn.addEventListener('click', () => this._cancelCurrentNote());

      this._bindMarkerDrag(marker, note);

      // Esc cancels.
      this._onKeyDown = (e) => { if (e.key === 'Escape') this._cancelCurrentNote(); };
      document.addEventListener('keydown', this._onKeyDown);
    }

    _stepFontSize(delta) {
      this.fontSize = Math.max(this.minFontSize, Math.min(this.maxFontSize, this.fontSize + delta));
      if (this.note) this.note.preview.style.fontSize = this.fontSize + 'px';
    }

    _bindMarkerDrag(marker, note) {
      let startX = 0, startY = 0, origX = 0, origY = 0, dragging = false;

      marker.addEventListener('pointerdown', (e) => {
        stop(e);
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        origX = note.x;
        origY = note.y;
        marker.setPointerCapture(e.pointerId);
        marker.style.cursor = 'grabbing';
      });

      marker.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const scale = this.getScale() || 1;
        const rect = this.stage.getBoundingClientRect();
        let nx = origX + (e.clientX - startX) / scale;
        let ny = origY + (e.clientY - startY) / scale;
        nx = Math.max(0, Math.min(nx, rect.width / scale));
        ny = Math.max(0, Math.min(ny, rect.height / scale));
        note.x = nx;
        note.y = ny;
        marker.style.left = nx + 'px';
        marker.style.top = ny + 'px';
        note.preview.style.left = nx + 'px';
        note.preview.style.top = ny + 'px';
      });

      const endDrag = () => { dragging = false; marker.style.cursor = 'grab'; };
      marker.addEventListener('pointerup', endDrag);
      marker.addEventListener('pointercancel', endDrag);
    }

    // ---- internal: burn / cancel ---------------------------------------

    _burnCurrentNote() {
      const note = this.note;
      if (!note) return;
      const text = note.input.value;

      if (text.trim() !== '') {
        const ctx = this.canvas.getContext('2d');
        ctx.font = this.fontSize + 'px ' + this.fontFamily;
        ctx.fillStyle = this.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, note.x, note.y);

        if (this.onBurn) {
          this.onBurn({ text, x: note.x, y: note.y, fontFamily: this.fontFamily, fontSize: this.fontSize, color: this.color });
        }
      }

      this._cleanupNote();
    }

    _cancelCurrentNote() {
      if (!this.note) return;
      this._cleanupNote();
      if (this.onCancel) this.onCancel();
    }

    _cleanupNote() {
      const note = this.note;
      if (!note) return;
      note.marker.remove();
      note.preview.remove();
      note.bar.remove();
      document.removeEventListener('keydown', this._onKeyDown);
      this.note = null;
    }
  }

  global.CanvasTextNote = CanvasTextNote;
})(window);