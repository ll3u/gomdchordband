let currentSongId = null;
let currentBpm = 90;
let autoscrollInterval = null;
let isScrolling = false;
let currentRawContent = "";

let isTwoFingerScrolling = false;
let touchStartScrollY = 0;
let isTwoFingerMode = false;
let startDistance = 0; // Speichert den Anfangsabstand der zwei Finger
let currentScale = 1.0; // Aktuelle Zoom-Stufe
let startScale = 1.0;

let autoscrollFrameId = null;
let lastScrollTime = 0;
let scrollAccumulator = 0;
/**
 * pauses autoscroll when touch gesutres are used
 * @type {boolean}
 */
let isTouchPaused = false; 

let currentTransposeOffset = 0;
let wakeLock = null;

let currentPlaylistFilter = "all";
let playlistsCachedData = [];

let selectedTheme = 'light';

// Canvas State
const canvas = document.getElementById('annotation-canvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let currentTool = 'draw'; // 'draw' oder 'erase'
let isPenEnabled = false;
let strokes = []; // Speichert Linien lokal

// DOM Elemente
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const scrollContainer = document.getElementById('scroll-container');
const btnAutoscroll = document.getElementById('btn-autoscroll');
const bpmSlider = document.getElementById('bpm-slider');
const bpmValDisplay = document.getElementById('bpm-val-display');
const wrapper = document.getElementById('wrapper');
const themeCheckbox = document.querySelector('.theme-switch #checkbox');
// Font size state
const fontSizeSlider = document.getElementById('font-size-slider');
const fontSizeDisplay = document.getElementById('font-size-display');
const progressRing = document.querySelector('.progress-ring-fill');

// 1. SIDEBAR TOGGLE (Für Tablets)
sidebarToggle.addEventListener('click', () => {
    if (window.innerWidth <= 1024) {
        sidebar.classList.toggle('open');
        // Disable pointer-events on top-bar EXCEPT for the menu toggle button
        const topBar = document.querySelector('.top-bar');
        const toggleButton = document.getElementById('sidebar-toggle');
        if (topBar) {
            if (sidebar.classList.contains('open')) {
                // Disable pointer-events on top-bar
                topBar.style.pointerEvents = 'none';
                // But re-enable for the toggle button so it can be clicked to close
                if (toggleButton) {
                    toggleButton.style.pointerEvents = 'auto';
                }
            } else {
                // Re-enable pointer-events on top-bar
                topBar.style.pointerEvents = 'auto';
            }
        } else {
        }
    } else {
        sidebar.classList.toggle('closed');
    }
    // always remove the pulse
    document.getElementById('menu-hint').classList.remove('pulse-dot');
});

// 2. SONG-DATEN VOM GO-BACKEND LADEN
async function loadSongs() {
    try {
        const res = await fetch('/api/songs');
        const songs = await res.json();
        const list = document.getElementById('song-list');
        list.innerHTML = '';

        let songsFiltered = songs;

        if (currentPlaylistFilter !== "all" && playlistsCachedData[currentPlaylistFilter]) {
            const activePlaylist = playlistsCachedData[currentPlaylistFilter];
            
            // Filtert und sortiert die Songs im Speicher exakt nach der JSON-Reihenfolge
            songsFiltered = activePlaylist.songs
                .map(filename => songs.find(song => song.id === filename || song.filename === filename))
                .filter(Boolean); // Entfernt ungültige Einträge
        }
        
        const isSetLoaded = songs.length !== songsFiltered.length;

        songsFiltered.forEach(song => {
            const li = document.createElement('li');
            li.textContent = song.title;
            if (isSetLoaded) {
                li.classList.add('setlist');
            }
            li.addEventListener('click', () => {
                selectSong(song.id);
                if (window.innerWidth <= 1024) {
                    sidebar.classList.remove('open');
                    updateTopBarPointerEvents();
                }
            });
            list.appendChild(li);
        });

        // ========================================================
        // NEU: AUTOMATISCHES PRE-CACHING ALLER SONGS IM HINTERGRUND
        // ========================================================
        // Wir triggern im Hintergrund ein unsichtbares Laden aller Songs.
        // Der Service Worker fängt diese Anfragen ab und speichert sie ab.

        if (navigator.onLine) {
            console.log(`Starte automatischen Offline-Sync für ${songsFiltered.length} Songs...`);
            
            songsFiltered.forEach(song => {
                // This simple fetch will trigger the service worker's caching logic
                fetch(`/api/songs/${encodeURIComponent(song.id)}`)
                    .then(response => {
                        if (response.ok) {
                            console.log(`✓ Gecacht: ${song.title}`);
                        }
                    })
                    .catch(e => console.error(`❌ Fehler beim Cachen von ${song.title}`, e));
            });
        }
    } catch (err) {
        console.log("Offline oder Server nicht erreichbar. Nutze Cache.", err);
    }
}

async function selectSong(id) {
    //reset zoom
    if (typeof currentScale !== 'undefined') currentScale = 1.0;
    //scroll up
    const scrollContainer = document.getElementById('scroll-container');
    if (scrollContainer) {
        scrollContainer.scrollTop = 0;
    }

    currentSongId = id;
    stopAutoscroll();

    document.querySelectorAll('#song-list li').forEach(li => li.classList.remove('active'));

    let song;
    const songUrl = `/api/songs/${encodeURIComponent(id)}`;

    try {
        const res = await fetch(songUrl);
        song = await res.json();
    } catch (fetchErr) {
        console.log(" Server offline. Versuche lokalen Cache über Service Worker...", fetchErr);
        try {
            const cachedResponse = await caches.match(songUrl);
            if (cachedResponse) {
                song = await cachedResponse.json();
            }
        } catch (cacheErr) {
            console.error(" Kritischer Fehler beim Auslesen des Caches:", cacheErr);
        }
    }

    if (!song || !song.content) {
        document.getElementById('song-render').innerHTML = "<h1> Lied offline nicht verfügbar</h1><p>Bitte dieses Lied einmalig im Online-Zustand laden.</p>";
        return;
    }

    currentRawContent = song.content;

    // BPM Laden
    const savedBpm = localStorage.getItem(`bpm_${id}`);
    if (savedBpm) {
        currentBpm = parseInt(savedBpm, 10);
    } else {
        const bpmMatch = song.content.match(/\*\*Tempo:\*\*\s*(\d+)/i) || song.content.match(/Tempo:\s*(\d+)/i);
        currentBpm = (bpmMatch && bpmMatch[1]) ? parseInt(bpmMatch[1], 10) : 90;
    }

    if (bpmSlider) bpmSlider.value = currentBpm;
    if (bpmValDisplay) bpmValDisplay.textContent = currentBpm;

    // Transpose-Wert für dieses spezifische Lied aus dem Speicher holen
    const savedTranspose = localStorage.getItem(`transpose_${id}`);
    currentTransposeOffset = savedTranspose ? parseInt(savedTranspose, 10) : 0;
    
    const transDisplay = document.getElementById('transpose-val-display');
    if (transDisplay) {
        transDisplay.textContent = (currentTransposeOffset >= 0 ? "+" : "") + currentTransposeOffset;
    }

    // Load saved font size for this song
    const savedFontSize = localStorage.getItem(`fontSize_${id}`);
    if (savedFontSize && fontSizeSlider) {
        fontSizeSlider.value = savedFontSize;
        fontSizeDisplay.textContent = savedFontSize;
    } else if (fontSizeSlider) {
        fontSizeSlider.value = 16;
        fontSizeDisplay.textContent = '16';
    }
    updateFontSize(); 
    // Das Zeichnen des Akkordblatts anwerfen
    renderChordSheet();
}

function renderChordSheet() {
    if (!currentRawContent) return;
    try {
        const lines = currentRawContent.split('\n');
        const songBodyText = currentRawContent;

        const cpParser = new ChordSheetJS.ChordProParser();
        const cpSong = cpParser.parse(songBodyText, { notation: 'GERMAN' });
      
        let transposedSong = null;
        if (currentTransposeOffset !== 0 && typeof ChordSheetJS.Chord !== 'undefined') {
            transposedSong = cpSong.transpose(currentTransposeOffset);
        }

        let baseSong = transposedSong ?? cpSong;
        const sharpSong = baseSong.useModifier('#');

        console.log(sharpSong.metadata);

        let headerHtml = parseUgHeader(sharpSong.metadata);
        sharpSong.metadata.set('title', '');
        sharpSong.metadata.set('subtitle', ''); 
        sharpSong.metadata.set('album', ''); 

        const divFormatter = new ChordSheetJS.HtmlDivFormatter();
        let mainBodyHtml = divFormatter.format(sharpSong);

        mainBodyHtml = mainBodyHtml.replace(/<div class="chord">B([b#]?)([^<]*)<\/div>/g, (match, accidental, rest) => {
          if (accidental === 'b') return `<div class="chord">B${rest}</div>`;
          if (accidental === '#') return `<div class="chord">B#${rest}</div>`;
          return `<div class="chord">H${rest}</div>`;
        });

        mainBodyHtml = mainBodyHtml.replace(/<div class="chord">([^<]+)<\/div>/g, (match, chordContent) => {
          const raisedNumbers = chordContent.replace(/(\([0-9]+\)|[0-9]+)/g, '<sup>$1</sup>');
          return `<div class="chord">${raisedNumbers}</div>`;
        });

        document.getElementById('song-render').innerHTML = DOMPurify.sanitize('<div class="ug-header-block">' + headerHtml + '</div><div class="ug-song-body">' + mainBodyHtml + '</div>');
    } catch (e) {
        console.error("Rendering fehlgeschlagen, nutze Fallback:", e);
    }

    setTimeout(() => {
        if (typeof resizeCanvas === "function") resizeCanvas();
        if (typeof loadCanvasData === "function") loadCanvasData();
    }, 50);
}

function parseUgHeader(metadata) {
    if (!metadata || typeof metadata.get !== 'function') return '';

    const getMeta = (key) => {
        const val = metadata.get(key);
        return val ? String(val).trim() : null;
    };

    const title  = getMeta('title');
    const artist = getMeta('artist');
    const tempo  = getMeta('tempo');
    const album   = getMeta('album');

    let headerHtml = '';

    if (title || artist) {
        const fullTitle = artist && title ? `${title} - ${artist}` : (title || artist);
        headerHtml += `<h1 class="ug-header-title">${fullTitle}</h1>`;
    }

    if (album) {
        headerHtml += `<div class="ug-header-meta">${album}</div>`;
    }

    if (tempo) {
        const bpmSuffix = tempo.toLowerCase().includes('bpm') ? '' : ' BPM';
        headerHtml += `<div class="ug-header-meta">Tempo: <strong>${tempo}${bpmSuffix}</strong></div>`;
    }
    return headerHtml;
}

function updateFontSize() {
    const size = parseInt(fontSizeSlider.value, 10);
    const songRender = document.getElementById('song-render');
    if (songRender) {
        songRender.style.fontSize = `${size}px`;
    }
    if (fontSizeDisplay) {
        fontSizeDisplay.textContent = size;
    }
    if (currentSongId) {
        localStorage.setItem(`fontSize_${currentSongId}`, size);
    }
    // Resize canvas to match new content height
    setTimeout(() => {
        if (typeof resizeCanvas === "function") resizeCanvas();
    }, 50);
}

function updateProgressRing() {
    if (!progressRing || !scrollContainer) return;

    const scrollTop = scrollContainer.scrollTop;
    const scrollHeight = scrollContainer.scrollHeight - scrollContainer.clientHeight;
    const progress = Math.min(scrollTop / scrollHeight, 1);

    // Circumference = 2 * PI * 26 = 163.36
    const offset = 163.36 * (1 - progress);
    progressRing.style.strokeDashoffset = offset;
}

// 3. AUTOMATISCHES ABSPIELEN & SCROLLEN (AUTOSCROLL)
function toggleAutoscroll() {
    if (isScrolling) {
        stopAutoscroll();
    } else {
        startAutoscroll();
    }
    updateProgressRing();
}

function startAutoscroll() {
    if (!currentSongId) return;
    
    // ABSICHERUNG GEGEN NOCK-ON-EFFEKT: Falls bereits eine Schleife aktiv ist, 
    // brechen wir sie starr ab, bevor wir eine neue starten. Das killt das Rasen!
    if (autoscrollFrameId) {
        cancelAnimationFrame(autoscrollFrameId);
    }
    
    isScrolling = true;
    if (btnAutoscroll) {
        const playIcon = document.getElementById('svg-play-icon');
        const pauseIcon = document.getElementById('svg-pause-icon');
        
        if (playIcon) playIcon.style.display = 'none';
        if (pauseIcon) pauseIcon.style.display = 'inline-block';

        btnAutoscroll.classList.add('active');
    }

    // Speicher zurücksetzen
    scrollAccumulator = 0;
    lastScrollTime = performance.now();
    const viewportHeight = scrollContainer.clientHeight;

    function scrollFrame(currentTime) {
        if (!isScrolling || isTouchPaused) {
            // Zeitstempel trotzdem aktualisieren, damit es nach dem Loslassen keinen "Sprung" macht
            lastScrollTime = currentTime; 
            autoscrollFrameId = requestAnimationFrame(scrollFrame);
            return;
        }

        const deltaTime = currentTime - lastScrollTime;
        lastScrollTime = currentTime;

        // Basis-Geschwindigkeit berechnen (BPM-basiert)
        const dynamicStep = viewportHeight * currentBpm * 0.00000025;
        const fractionalStep = dynamicStep * deltaTime;

        // Wir addieren den Bruchteil auf unseren Speicher auf
        scrollAccumulator += fractionalStep;

        // BEHOBEN: Sobald sich 1 oder mehr ganze Pixel angesammelt haben,
        // scrollen wir um exakt diese Zahl. Dadurch stoppt das Scrollen bei 40 nie wieder!
        if (scrollAccumulator >= 1) {
            const pixelsToScroll = Math.floor(scrollAccumulator);
            scrollContainer.scrollBy(0, pixelsToScroll);
            scrollAccumulator -= pixelsToScroll; // Rest im Speicher belassen
        }

        autoscrollFrameId = requestAnimationFrame(scrollFrame);
    }

    autoscrollFrameId = requestAnimationFrame(scrollFrame);
}

function stopAutoscroll() {
    isScrolling = false;
    if (btnAutoscroll) {
        const playIcon = document.getElementById('svg-play-icon');
        const pauseIcon = document.getElementById('svg-pause-icon');
        
        if (playIcon) playIcon.style.display = 'inline-block';
        if (pauseIcon) pauseIcon.style.display = 'none';

        btnAutoscroll.classList.remove('active');
    }
    // Schleife sauber aus dem Speicher werfen
    if (autoscrollFrameId) {
        cancelAnimationFrame(autoscrollFrameId);
        autoscrollFrameId = null;
    }
}

btnAutoscroll.addEventListener('click', toggleAutoscroll);

// 4. CANVAS ZEICHEN-LOGIK (TOUCH & MOUSE SUPPORT)
function resizeCanvas() {
    const wrapper = document.getElementById('wrapper');
    canvas.width = wrapper.clientWidth;
    canvas.height = wrapper.clientHeight;
    redrawCanvas();
}

let touchTimeout = null;


window.addEventListener('resize', resizeCanvas);

function startDrawing(e) {
    if (touchTimeout) clearTimeout(touchTimeout);

    if (!isPenEnabled && e.touches && e.touches.length === 1) {
        isTouchPaused = true; 

        if (e.cancelable) {
            e.preventDefault(); 
        }
    }
    
    // BEVOR ALLEM: Wenn Sidebar offen ist, alle Touch-Events durchlassen
    if (sidebar.classList.contains('open')) {
        return;
    }

    // 1. ZWEI-FINGER-MODUS (ZOOM & SCROLL) INITIALISIEREN
    if (e.touches && e.touches.length === 2) {
        isDrawing = false;
        isTwoFingerMode = true;
        
        const t1 = e.touches[0];
        const t2 = e.touches[1];
        
        // Mittelpunkt fürs Scrollen merken
        touchStartScrollY = (t1.clientY + t2.clientY) / 2;
        
        // Abstand für den Zoom berechnen
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        startDistance = Math.sqrt(dx * dx + dy * dy);
        startScale = currentScale;

        // Fokus-Mittelpunkt relativ zum Wrapper setzen
        const rect = wrapper.getBoundingClientRect();
        const midX = ((t1.clientX + t2.clientX) / 2) - rect.left;
        const midY = ((t1.clientY + t2.clientY) / 2) - rect.top;
        
        const originX = midX / currentScale;
        const originY = midY / currentScale;

        wrapper.style.transformOrigin = `${originX}px ${originY}px`;
        
        e.preventDefault();
        return;
    }

    // 2. EIN-FINGER-MODUS (MALEN) MIT VERZÖGERUNG gegen Klecksen
    isTwoFingerMode = false;
    isDrawing = false;

    // stop painting !!!
    if (!isPenEnabled) {
        if (e.touches && e.touches.length === 1) {
            touchStartScrollY = e.touches[0].clientY;
        }
        return;
    }

    // Koordinaten für den verzögerten Start sichern
    const savedCoords = getCoords(e);

    touchTimeout = setTimeout(() => {
        if (!isTwoFingerMode) {
            isDrawing = true;
            ctx.beginPath();
            ctx.moveTo(savedCoords.x, savedCoords.y);
            
            strokes.push({
                tool: currentTool,
                color: document.getElementById('color-picker').value,
                size: document.getElementById('brush-size').value,
                points: [{x: savedCoords.x, y: savedCoords.y}]
            });
        }
    }, 80); // 80ms Verzögerung fängt den Versatz des 2. Fingers perfekt ab
}

function draw(e) {
    // DEBUG: Log touchmove events
    
    // BEVOR ALLEM: Wenn Sidebar offen ist, alle Touch-Events durchlassen
    if (sidebar.classList.contains('open')) {
        return;
    }

    // enable one-finger scroll
    if (!isPenEnabled && e.touches && e.touches.length === 1) {
        isTouchPaused = true;
        e.preventDefault(); // Verhindert Ruckeln des Standard-Browsers
        const currentY = e.touches[0].clientY;
        const deltaY = touchStartScrollY - currentY; // Berechnet die Wisch-Distanz
        
        // Scrollt den echten Lieder-Textcontainer um diesen Wert
        const scrollContainer = document.getElementById('scroll-container');
        if (scrollContainer) {
            scrollContainer.scrollBy(0, deltaY * (1 / currentScale));
        }
        touchStartScrollY = currentY; // Aktualisiert die Position für die flüssige Bewegung
        return; // Bricht ab, damit keine Mal-Logik ausgeführt wird
    }

    // A) LOGIK FÜR ZWEI FINGER (SCROLLEN & ZOOMEN)
    if (isTwoFingerMode && e.touches && e.touches.length === 2) {
        e.preventDefault();

        const t1 = e.touches[0];
        const t2 = e.touches[1];

        // PINCH TO ZOOM
        const dx = t1.clientX - t2.clientX;
        const dy = t1.clientY - t2.clientY;
        const currentDistance = Math.sqrt(dx * dx + dy * dy);

        if (startDistance > 0) {
            const factor = currentDistance / startDistance;
            currentScale = Math.min(Math.max(startScale * factor, 1.0), 2.5);
            wrapper.style.transform = `scale(${currentScale})`;
        }

        // ZWEI-FINGER-SCROLLING
        const currentY = (t1.clientY + t2.clientY) / 2;
        const deltaY = touchStartScrollY - currentY;
        scrollContainer.scrollBy(0, deltaY * (1 / currentScale));
        touchStartScrollY = currentY;
        return;
    }

    // B) LOGIK FÜR EINEN FINGER (MALEN)
    if (!isDrawing) return;
    
    e.preventDefault();

    const coords = getCoords(e);

    const currentStroke = strokes[strokes.length - 1];
    if (currentStroke && currentStroke.points) {
        currentStroke.points.push({ x: coords.x, y: coords.y });
        redrawCanvas();
    }
}

function stopDrawing(e) {
    if (touchTimeout) clearTimeout(touchTimeout);
    isTouchPaused = false;
    
    
    if (e && e.touches && e.touches.length === 0) {
        isTwoFingerMode = false;
        startDistance = 0;
    }

    if (!isDrawing) return;
    isDrawing = false;

    // 1. Zuerst die berührten Pfade komplett entfernen
    cleanUpErasedStrokes();

    // 2. Danach den sauberen Zustand speichern
    saveCanvasData();
}

// Sichere Koordinatenberechnung (unterstützt Maus und Touch absolut fehlerfrei)
function getCoords(e) {
    const rect = canvas.getBoundingClientRect();
    let clientX = 0;
    let clientY = 0;

    if (e.touches && e.touches.length > 0) {
        clientX = e.touches[0].clientX;
        clientY = e.touches[0].clientY;
    } else {
        clientX = e.clientX;
        clientY = e.clientY;
    }

    return {
        x: (clientX - rect.left) / currentScale,
        y: (clientY - rect.top) / currentScale
    };
}
// Stelle sicher, dass die Event Listener sauber registriert sind
canvas.removeEventListener('touchstart', startDrawing);
canvas.removeEventListener('touchmove', draw);
canvas.removeEventListener('touchend', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, {passive: false});
canvas.addEventListener('touchmove', draw, {passive: false});
canvas.addEventListener('touchend', stopDrawing);

// Add debug logging for sidebar touch events
let sidebarTouchStartY = 0;

sidebar.addEventListener('touchstart', (e) => {
    isTouchPaused = true;
    // Store initial touch position for manual scrolling
    if (e.touches && e.touches.length > 0) {
        sidebarTouchStartY = e.touches[0].clientY;
    }
}, {passive: true});

sidebar.addEventListener('touchend', (e) => {
    isTouchPaused = false;

    sidebarTouchStartY = 0;
}, {passive: true});

sidebar.addEventListener('touchmove', (e) => {
     isTouchPaused = true; 
    // Try explicit scrolling - prevent default and manually scroll
    if (e.cancelable && !e.defaultPrevented && e.touches && e.touches.length > 0) {
        e.preventDefault();
        const deltaY = e.touches[0].clientY - sidebarTouchStartY;
        sidebarTouchStartY = e.touches[0].clientY;
        const newScrollTop = sidebar.scrollTop - deltaY;
        sidebar.scrollTop = newScrollTop;
    }
}, {passive: false});

// Add debug logging for document touch events
document.addEventListener('touchstart', (e) => {
}, {passive: true, capture: true});

document.addEventListener('touchmove', (e) => {
}, {passive: true, capture: true});

// Event Listener für Touch (Tablet) & Maus
canvas.addEventListener('mousedown', startDrawing);
canvas.addEventListener('mousemove', draw);
canvas.addEventListener('mouseup', stopDrawing);

canvas.addEventListener('touchstart', startDrawing, {passive: false});
canvas.addEventListener('touchmove', draw, {passive: false});
canvas.addEventListener('touchend', stopDrawing);

function redrawCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    strokes.forEach(stroke => {
        if (stroke.points.length < 2) return;
        ctx.beginPath();
        ctx.strokeStyle = stroke.tool === 'erase' ? '#ffffff' : stroke.color;
        ctx.lineWidth = stroke.size;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        // Zeichne im "Destination-Out" Modus falls Radiergummi für echtes Freiradieren gewünscht
        ctx.globalCompositeOperation = stroke.tool === 'erase' ? 'destination-out' : 'source-over';
        
        ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
            ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over'; // Zurücksetzen
}
function cleanUpErasedStrokes() {
    // Hole den letzten gezeichneten Strich (den Radierer-Pfad)
    const lastStroke = strokes[strokes.length - 1];
    
    // Falls kein Strich existiert oder es kein Radiergummi war -> abbrechen
    if (!lastStroke || lastStroke.tool !== 'erase') return;

    // Entferne den Radiergummi-Strich selbst aus dem Array (er wird nicht mehr gebraucht)
    strokes.pop();

    // Filtere das strokes-Array: Behalte nur Pfade, die NICHT berührt wurden
    strokes = strokes.filter(stroke => {
        // Andere Radiergummis im Array ignorieren
        if (stroke.tool === 'erase') return true; 
        if (stroke.points.length < 2) return true;

        // Erstelle den Pfad des normalen Strichs im Hintergrund für die Prüfung
        const path2d = new Path2D();
        path2d.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
            path2d.lineTo(stroke.points[i].x, stroke.points[i].y);
        }

        // Nutze die echte Dicke des gezeichneten Strichs plus die Dicke des Radierers
        // Das sorgt dafür, dass die Kollision absolut präzise erkannt wird
        ctx.lineWidth = stroke.size + lastStroke.size; 

        // Prüfe, ob mindestens ein Punkt des Radiergummis diesen Strich schneidet
        const isTouched = lastStroke.points.some(point => 
            ctx.isPointInStroke(path2d, point.x, point.y)
        );

        // Wenn er berührt wurde, filtere ihn heraus (gibt false zurück)
        return !isTouched;
    });

    // Zeichne das Canvas neu (die getroffenen Pfade verschwinden komplett)
    redrawCanvas();
}

// 5. LOCAL STORAGE (Lokale Notizen sichern)
function saveCanvasData() {
    if (!currentSongId) return;
    localStorage.setItem(`canvas_${currentSongId}`, JSON.stringify(strokes));
}

function loadCanvasData() {
    const data = localStorage.getItem(`canvas_${currentSongId}`);
    strokes = data ? JSON.parse(data) : [];
    redrawCanvas();
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('Wake Lock released');
        wakeLock = null;
      });
    }
  } catch (err) {
    console.error('Failed to enable wake lock:', err);
  }
}

// Release screen wake lock
function releaseWakeLock() {
  if (wakeLock !== null) {
    wakeLock.release().then(() => {
      wakeLock = null;
    });
  }
}

// Toolbar Werkzeuge steuern
document.getElementById('tool-draw').addEventListener('click', () => {
    if (isPenEnabled && currentTool === 'draw') {
        isPenEnabled = false;
        document.getElementById('tool-draw').classList.remove('active');
    } else {
        currentTool = 'draw';
        isPenEnabled = true;
        document.getElementById('tool-draw').classList.add('active');
        document.getElementById('tool-erase').classList.remove('active');
    }
});

document.getElementById('tool-erase').addEventListener('click', () => {
    if (isPenEnabled && currentTool === 'erase') {
        isPenEnabled = false;
        document.getElementById('tool-erase').classList.remove('active');
    } else {
        currentTool = 'erase';
        isPenEnabled = true;
        document.getElementById('tool-erase').classList.add('active');
        document.getElementById('tool-draw').classList.remove('active');
    }
});

document.getElementById('btn-clear-canvas').addEventListener('click', () => {
    strokes = [];
    saveCanvasData();
    redrawCanvas();
});

// Import / Export
document.getElementById('btn-export').addEventListener('click', () => {
    const backup = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if ((key.startsWith('canvas_') || key.startsWith('bpm_') || key.startsWith('fontSize_') || key.startsWith('transpose_'))) {
            backup[key] = localStorage.getItem(key);
        }
    }
    const blob = new Blob([JSON.stringify(backup)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `band-chords-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
});

document.getElementById('btn-import').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
        const backup = JSON.parse(evt.target.result);
        Object.keys(backup).forEach(key => localStorage.setItem(key, backup[key]));
        
        if (currentSongId) {
            loadCanvasData();
            const savedBpm = localStorage.getItem(`bpm_${currentSongId}`);
            if (savedBpm) {
                currentBpm = parseInt(savedBpm, 10);
                if (bpmSlider) bpmSlider.value = currentBpm;
                if (bpmValDisplay) bpmValDisplay.textContent = currentBpm;
            }

            if (typeof selectSong === "function") {
                selectSong(currentSongId);
            }
        }
        alert("Notizen und Song-Geschwindigkeiten erfolgreich importiert!");
    };
    reader.readAsText(file);
});

// Function to update top-bar pointer-events based on sidebar state
function updateTopBarPointerEvents() {
    const topBar = document.querySelector('.top-bar');
    const toggleButton = document.getElementById('sidebar-toggle');
    const isMobile = window.innerWidth <= 1024;
    const isOpen = sidebar.classList.contains('open');
    if (topBar && isMobile) {
        if (isOpen) {
            topBar.style.pointerEvents = 'none';
            if (toggleButton) {
                toggleButton.style.pointerEvents = 'auto';
            }
        } else {
            topBar.style.pointerEvents = 'auto';
        }
    } else if (topBar) {
        topBar.style.pointerEvents = 'auto';
    }
}

// Initialisierung beim Start
window.onload = () => {
    
    // Set initial top-bar pointer-events state
    updateTopBarPointerEvents();
    
    // Update on resize
    window.addEventListener('resize', updateTopBarPointerEvents);
    
    // Add touch event logging to content viewer
    const contentViewer = document.querySelector('.content-viewer');
    if (contentViewer) {
        contentViewer.addEventListener('touchstart', (e) => {
        }, {passive: true});
        
        contentViewer.addEventListener('touchmove', (e) => {
        }, {passive: true});
    }
    
    // Add touch event logging to wrapper (canvas container)
    if (wrapper) {
        wrapper.addEventListener('touchstart', (e) => {
        }, {passive: true});
        
        wrapper.addEventListener('touchmove', (e) => {
        }, {passive: true});
    }
    
    // add setlist-event listener
    const chipGroup = document.getElementById('playlist-chips');
    if (chipGroup) {
        chipGroup.addEventListener('click', handlePlaylistFilterClick);
    }

    // load songs
    loadSongs();
    // init setlitst
    initSetlists();

    document.getElementById('btn-refresh').addEventListener('click', loadSongs);

    const btnTransUp = document.getElementById('btn-transpose-up');
    const btnTransDown = document.getElementById('btn-transpose-down');
    const transDisplay = document.getElementById('transpose-val-display');

    if (btnTransUp && btnTransDown) {
        btnTransUp.addEventListener('click', () => {
            currentTransposeOffset++;
            if (transDisplay) transDisplay.textContent = (currentTransposeOffset >= 0 ? "+" : "") + currentTransposeOffset;
            if (currentSongId) localStorage.setItem(`transpose_${currentSongId}`, currentTransposeOffset);
            renderChordSheet(); // Erzwingt das sofortige Neuzeichnen mit den neuen Akkorden
        });

        btnTransDown.addEventListener('click', () => {
            currentTransposeOffset--;
            if (transDisplay) transDisplay.textContent = (currentTransposeOffset >= 0 ? "+" : "") + currentTransposeOffset;
            if (currentSongId) localStorage.setItem(`transpose_${currentSongId}`, currentTransposeOffset);
            renderChordSheet();
        });
    }

    const colorPicker = document.getElementById('color-picker');
    const colorIcon = document.getElementById('svg-color-icon');
    
    if (colorPicker && colorIcon) {
        colorPicker.addEventListener('input', (e) => {
            // Ändert die CSS-Füllfarbe des SVGs in Echtzeit beim Schieben im Farbrad
            colorIcon.style.fill = e.target.value;
        });
    }

    // Handle fullscreen changes (e.g., user presses Esc)
    document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) {
        requestWakeLock();
    } else {
        releaseWakeLock();
    }
    });

    // Handle page visibility changes
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && document.fullscreenElement) {
            requestWakeLock();
        } else {
            releaseWakeLock();
        }
    });

    if (scrollContainer) {
        scrollContainer.addEventListener('scroll', updateProgressRing, { passive: true });
        updateProgressRing();
    }

    // load stored theme
    if (localStorage.getItem('settings.theme') === 'dark' && themeCheckbox) {
        themeCheckbox.checked = true;
    }
};

// Reagiert sofort, wenn man den Schieberegler bewegt
bpmSlider.addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10);
    currentBpm = val;
   if (bpmValDisplay) {
        bpmValDisplay.textContent = val; // Zahl live aktualisieren
    } 

    // NEU: Speichert den BPM-Wert sofort für diesen Song lokal ab
    if (currentSongId) {
        localStorage.setItem(`bpm_${currentSongId}`, val);
    }
    
    // Falls das Autoscroll läuft, Tempo sofort ohne Pause anpassen
    if (isScrolling) {
        clearInterval(autoscrollInterval);
        startAutoscroll(); 
    }
});

// Verhindert, dass die Canvas-Logik das Sliden auf Android blockiert
const stopPropagation = (e) => e.stopPropagation();

// Dem Pinsel-Slider seine Touch-Rechte zurückgeben
const brushSlider = document.getElementById('brush-size');
if (brushSlider) {
    brushSlider.addEventListener('touchstart', stopPropagation, { passive: true });
    brushSlider.addEventListener('touchmove', stopPropagation, { passive: true });
}

// Dem BPM-Slider seine Touch-Rechte zurückgeben
if (bpmSlider) {
    bpmSlider.addEventListener('touchstart', stopPropagation, { passive: true });
    bpmSlider.addEventListener('touchmove', stopPropagation, { passive: true });
}

if (fontSizeSlider) {
    fontSizeSlider.addEventListener('input', updateFontSize, { passive: true });
    // Initialize on load
    updateFontSize();
}

document.getElementById('btn-undo').addEventListener('click', () => {
    if (!currentSongId || strokes.length === 0) return;

    // Den letzten Strich aus dem Array entfernen
    strokes.pop();

    // Den neuen Zustand im Browser-Speicher sichern
    saveCanvasData();

    // Das Canvas leeren und ohne den gelöschten Strich neu aufbauen
    redrawCanvas();
});

themeCheckbox.addEventListener('change', (e) => {
    if (e.target.checked) {
        localStorage.setItem('settings.theme', 'dark');
    } else {
        localStorage.setItem('settings.theme', 'light');
    }
});

const btnCollapse = document.getElementById('btn-footer-collapse');
const drawerBar = document.getElementById('collapsible-drawer-bar');
const overlayContainer = document.querySelector('.action-overlay-container');
const arrowPath = document.getElementById('svg-collapse-arrow');
const contentViewer = document.querySelector('.content-viewer');

if (btnCollapse && drawerBar && overlayContainer && arrowPath && contentViewer) {
    let isDrawerOpen = false; // KORRIGIERT: Startet ab jetzt standardmäßig GESCHLOSSEN (false)
    
    // INITIALISIERUNG BEIM START (Zwingt Pille und Text ganz nach unten)
    const isMobileOnLoad = window.innerWidth <= 600;
    if (isMobileOnLoad) {
        contentViewer.style.setProperty('margin-bottom', '0px', 'important');
        overlayContainer.style.setProperty('bottom', '16px', 'important');
    } else {
        contentViewer.style.margin_bottom = '16px';
        overlayContainer.style.bottom = '16px';
    }
    
    btnCollapse.addEventListener('click', () => {
        isDrawerOpen = !isDrawerOpen;
        const isMobile = window.innerWidth <= 600;

        if (isDrawerOpen) {
            // 1. AUFKLAPPEN (Werkzeuge einblenden)
            drawerBar.classList.remove('drawer-closed');
            arrowPath.setAttribute('d', 'M19 9L12 15L6 9'); // Pfeil zeigt nach unten
            
            if (isMobile) {
                contentViewer.style.setProperty('margin-bottom', '100px', 'important');
                overlayContainer.style.setProperty('bottom', '112px', 'important');
            } else {
                contentViewer.style.margin_bottom = '54px';
                overlayContainer.style.bottom = '60px';
            }
        } else {
            // 2. ZUKLAPPEN (Werkzeuge verstecken)
            drawerBar.classList.add('drawer-closed');
            arrowPath.setAttribute('d', 'M6 15L12 9L18 15'); // Pfeil zeigt nach oben
            
            if (isMobile) {
                contentViewer.style.setProperty('margin-bottom', '0px', 'important');
                overlayContainer.style.setProperty('bottom', '16px', 'important');
            } else {
                contentViewer.style.margin_bottom = '16px';
                overlayContainer.style.bottom = '16px';
            }
        }
        
        if (typeof resizeCanvas === "function") resizeCanvas();
    });
}

document.getElementById('btn-fullscreen').addEventListener('click', async () => {
  if (!document.fullscreenElement) {
    await document.documentElement.requestFullscreen();
    await requestWakeLock();
  } else {
    releaseWakeLock();
    document.exitFullscreen();
  }
});

// playlist feature
function handlePlaylistFilterClick(event) {
    const chipGroup = document.getElementById('playlist-chips');
    if (!chipGroup) return;

    const clickedChip = event.target.closest('.playlist-chip');
    if (!clickedChip) return;

    chipGroup.querySelectorAll('.playlist-chip').forEach(c => c.classList.remove('playlist-chip-active'));
    clickedChip.classList.add('playlist-chip-active');

    currentPlaylistFilter = clickedChip.getAttribute('data-playlist');

    if (typeof loadSongs === 'function') {
        loadSongs(); 
    }
}

function initSetlists() {
    const chipGroup = document.getElementById('playlist-chips');
    if (!chipGroup) return;

    const dynamicChips = chipGroup.querySelectorAll('.playlist-chip:not([data-playlist="all"])');
    dynamicChips.forEach(chip => chip.remove());

    fetch('/api/setlists')
        .then(res => res.json())
        .then(data => {
            playlistsCachedData = data;
            
            playlistsCachedData.forEach((list, index) => {
                const button = document.createElement('button');
                button.className = 'playlist-chip';
                button.setAttribute('data-playlist', index); 
                button.textContent = DOMPurify.sanitize(list.name); 
                chipGroup.appendChild(button);
            });
        })
        .catch(err => console.error("fetch failed: setlist cache", err));
}