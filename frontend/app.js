const md = window.markdownit({ html: true });
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

let currentTransposeOffset = 0;

// Canvas State
const canvas = document.getElementById('annotation-canvas');
const ctx = canvas.getContext('2d');
let isDrawing = false;
let currentTool = 'draw'; // 'draw' oder 'erase'
let strokes = []; // Speichert Linien lokal

// DOM Elemente
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');
const scrollContainer = document.getElementById('scroll-container');
const btnAutoscroll = document.getElementById('btn-autoscroll');
const bpmSlider = document.getElementById('bpm-slider');
const bpmValDisplay = document.getElementById('bpm-val-display');
const wrapper = document.getElementById('wrapper');

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
});

// 2. SONG-DATEN VOM GO-BACKEND LADEN
async function loadSongs() {
    try {
        const res = await fetch('/api/songs');
        const songs = await res.json();
        const list = document.getElementById('song-list');
        list.innerHTML = '';
        
        songs.forEach(song => {
            const li = document.createElement('li');
            li.textContent = song.title;
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
            console.log(`Starte automatischen Offline-Sync für ${songs.length} Songs...`);
            
            songs.forEach(song => {
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

    // Das Zeichnen des Akkordblatts anwerfen
    renderChordSheet();
}

function renderChordSheet() {
    if (!currentRawContent) return;
    try {
        const lines = currentRawContent.split('\n');
        let headerHtml = "";
        let songBodyLines = [];
        let inHeader = true;

        lines.forEach(line => {
            const trimmed = line.trim();

            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                inHeader = false;
            }

            if (inHeader) {
                if (trimmed.startsWith('# ')) {
                    headerHtml += `<h1 class="ug-header-title">${trimmed.replace('# ', '')}</h1>`;
                } 
                else if (trimmed.toLowerCase().includes('tempo:')) {
                    const cleanBpm = trimmed.replace(/\*/g, '');
                    headerHtml += `<div class="ug-header-meta"><strong>${cleanBpm}</strong></div>`;
                } 
                else if (trimmed.toLowerCase().includes('tuning:') || trimmed.toLowerCase().includes('key:') || trimmed.toLowerCase().includes('capo:')) {
                    const cleanMeta = trimmed.replace(/\*/g, '');
                    headerHtml += `<div class="ug-header-meta">${cleanMeta}</div>`;
                }
            } else {
                songBodyLines.push(line);
            }
        });

        while (songBodyLines.length > 0 && songBodyLines[0].trim() === "") {
            songBodyLines.shift();
        }

        const songBodyText = songBodyLines.join('\n');

        const ugParser = new ChordSheetJS.UltimateGuitarParser();
        const ugSong = ugParser.parse(songBodyText);
        
        let transposedSong = null;
        if (currentTransposeOffset !== 0 && typeof ChordSheetJS.Chord !== 'undefined') {
            transposedSong = ugSong.transpose(currentTransposeOffset);
        }

        let baseSong = transposedSong ?? ugSong;
        const sharpSong = baseSong.useModifier('#');

        const cpFormatter = new ChordSheetJS.ChordProFormatter();
        const cpBody = cpFormatter.format(sharpSong);

        const cpParser = new ChordSheetJS.ChordProParser();
        const cpSong = cpParser.parse(cpBody);

        const divFormatter = new ChordSheetJS.HtmlDivFormatter();
        const mainBodyHtml = divFormatter.format(cpSong);

        // HTML in das Dokument schreiben
        document.getElementById('song-render').innerHTML = '<div class="ug-header-block">' + headerHtml + '</div><div class="ug-song-body">' + mainBodyHtml + '</div>';
    } catch (e) {
        console.error("Rendering fehlgeschlagen, nutze Fallback:", e);
        if (window.markdownit) {
            const md = window.markdownit({ html: true });
            document.getElementById('song-render').innerHTML = md.render(currentRawContent);
        }
    }

    setTimeout(() => {
        if (typeof resizeCanvas === "function") resizeCanvas();
        if (typeof loadCanvasData === "function") loadCanvasData();
    }, 50);
}

// 3. AUTOMATISCHES ABSPIELEN & SCROLLEN (AUTOSCROLL)
function toggleAutoscroll() {
    if (isScrolling) {
        stopAutoscroll();
    } else {
        startAutoscroll();
    }
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
        if (!isScrolling) return;

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

    // DEBUG: Log which element is receiving touch
    
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
    // Store initial touch position for manual scrolling
    if (e.touches && e.touches.length > 0) {
        sidebarTouchStartY = e.touches[0].clientY;
    }
}, {passive: true});

sidebar.addEventListener('touchend', (e) => {
    sidebarTouchStartY = 0;
}, {passive: true});

sidebar.addEventListener('touchmove', (e) => {
    
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

// Toolbar Werkzeuge steuern
document.getElementById('tool-draw').addEventListener('click', () => {
    currentTool = 'draw';
    document.getElementById('tool-draw').classList.add('active');
    document.getElementById('tool-erase').classList.remove('active');
});

document.getElementById('tool-erase').addEventListener('click', () => {
    currentTool = 'erase';
    document.getElementById('tool-erase').classList.add('active');
    document.getElementById('tool-draw').classList.remove('active');
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
        // Sichert sowohl die Canvas-Zeichnungen als auch die Song-Geschwindigkeiten
        if (key.startsWith('canvas_') || key.startsWith('bpm_')) {
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
        
        // Aktualisiert nach dem Import sowohl das Canvas als auch den Tempo-Regler live
        if (currentSongId) {
            loadCanvasData();
            const savedBpm = localStorage.getItem(`bpm_${currentSongId}`);
            if (savedBpm) {
                currentBpm = parseInt(savedBpm, 10);
                if (bpmSlider) bpmSlider.value = currentBpm;
                if (bpmValDisplay) bpmValDisplay.textContent = currentBpm;
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
    
    loadSongs();
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


document.getElementById('btn-undo').addEventListener('click', () => {
    if (!currentSongId || strokes.length === 0) return;

    // Den letzten Strich aus dem Array entfernen
    strokes.pop();

    // Den neuen Zustand im Browser-Speicher sichern
    saveCanvasData();

    // Das Canvas leeren und ohne den gelöschten Strich neu aufbauen
    redrawCanvas();
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

document.getElementById('btn-fullscreen').addEventListener('click', () => {
    // Sicherstellen, dass das Dokument nicht bereits im Vollbild ist
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen()
            .catch(err => {
                console.error(`Vollbild verweigert: ${err.message}`);
            });
    } else {
        document.exitFullscreen();
    }
});