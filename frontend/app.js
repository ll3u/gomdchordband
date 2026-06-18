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
                if (window.innerWidth <= 1024) sidebar.classList.remove('open');
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
            
            // Nutze Promise.all, um alle Songs parallel im Hintergrund anzufordern
            Promise.all(songs.map(song => 
                fetch(`/api/songs/${encodeURIComponent(song.id)}`)
                    .then(r => console.log(`✓ Gecacht: ${song.title}`))
                    .catch(e => console.error(`❌ Fehler beim Cachen von ${song.title}`, e))
            )).then(() => {
                console.log("🎉 Alle Songs erfolgreich offline verfügbar!");
            });
        }
    } catch (err) {
        console.log("Offline oder Server nicht erreichbar. Nutze Cache.", err);
    }
}

async function selectSong(id) {
    currentSongId = id;
    stopAutoscroll();
    
    document.querySelectorAll('#song-list li').forEach(li => li.classList.remove('active'));
    
    const res = await fetch(`/api/songs/${encodeURIComponent(id)}`);
    const song = await res.json();
    
    // Originalen Inhalt sichern
    currentRawContent = song.content;
    
    // Suchen und ersetzen in der Funktion selectSong(id):
    const bpmMatch = song.content.match(/\*\*Tempo:\*\*\s*(\d+)/i) || song.content.match(/Tempo:\s*(\d+)/i);
    
    // Ersten Treffer (die reine Zahlengruppe) isolieren, ansonsten Standard auf 90 setzen
    currentBpm = (bpmMatch && bpmMatch[1]) ? parseInt(bpmMatch[1], 10) : 90;
    
    // Werte an die neuen Slider-Elemente übergeben
    bpmSlider.value = currentBpm;
    bpmValDisplay.textContent = currentBpm;

    // RENDERING MIT CHORDSHEETJS (Ersetzt die alte md.render Zeile)
    try {
        const parser = new ChordSheetJS.UltimateGuitarParser();
        const parsedSong = parser.parse(currentRawContent);
        const formatter = new ChordSheetJS.HtmlDivFormatter();
        
        document.getElementById('song-render').innerHTML = formatter.format(parsedSong);
    } catch (e) {
        console.error("ChordSheetJS fehlgeschlagen, verwende originalen Markdown Fallback", e);
        // Falls kein Song-Tab vorliegt, greift dein originaler Markdown-Parser
        document.getElementById('song-render').innerHTML = md.render(currentRawContent);
    }

    // Dem Browser 50ms Zeit geben, das Layout aufzubauen,
    // damit wrapper.clientHeight die echte Gesamthöhe des Songs liefert.
    setTimeout(() => {
        resizeCanvas();
        loadCanvasData();
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
    isScrolling = true;
    btnAutoscroll.textContent = "⏸ Pause";
    btnAutoscroll.style.backgroundColor = "var(--accent)";

    // Scroll-Geschwindigkeit proportional zu den BPM berechnen
    // Ein Pixel-Scroll alle X Millisekunden
    const intervalMs = Math.max(10, 12000 / currentBpm); 

    autoscrollInterval = setInterval(() => {
        scrollContainer.scrollBy(0, 1);
    }, intervalMs);
}

function stopAutoscroll() {
    isScrolling = false;
    btnAutoscroll.textContent = "▶ Play";
    btnAutoscroll.style.backgroundColor = "";
    clearInterval(autoscrollInterval);
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
    
    if (e.touches && e.touches.length === 0) {
        isTwoFingerMode = false;
        startDistance = 0;
    }

    if (!isDrawing) return;
    isDrawing = false;
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
        if (key.startsWith('canvas_')) {
            backup[key] = localStorage.getItem(key);
        }
    }
    const blob = new Blob([JSON.stringify(backup)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `band-chords-annotations-${new Date().toISOString().slice(0,10)}.json`;
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
        if (currentSongId) loadCanvasData();
        alert("Notizen erfolgreich importiert!");
    };
    reader.readAsText(file);
});

// Initialisierung beim Start
window.onload = () => {
    loadSongs();
    document.getElementById('btn-refresh').addEventListener('click', loadSongs);
};

// Reagiert sofort, wenn man den Schieberegler bewegt
bpmSlider.addEventListener('input', (e) => {
    let val = parseInt(e.target.value, 10);
    currentBpm = val;
    bpmValDisplay.textContent = val; // Zahl live aktualisieren
    
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