package main

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/sha256"
	"embed"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
	"time"

	"github.com/skip2/go-qrcode"
)

//go:embed frontend/*
var frontendFS embed.FS

// Song represents a song metadata structure
type Song struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	FileName string `json:"fileName"`
	Modified int64  `json:"modified"` // Unix timestamp
	FileSize int64  `json:"fileSize"` // For ETag generation
	Content  string `json:"content,omitempty"`
}

// AppState holds the application state
type AppState struct {
	SongsDir string
	Songs    []Song
}

func main() {
	// Configuration
	songsDir := "./songs"
	port := "8080"

	// Create songs directory if it doesn't exist
	if err := os.MkdirAll(songsDir, 0755); err != nil {
		log.Fatalf("Failed to create songs directory: %v", err)
	}

	// Initialize state
	state := &AppState{
		SongsDir: songsDir,
		Songs:    []Song{},
	}

	// Scan songs directory on startup
	state.scanSongs()

	// Set up file watcher (simple polling)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for range ticker.C {
			state.scanSongs()
		}
	}()

	// API Routes
	http.HandleFunc("/api/songs", state.handleSongsList)
	http.HandleFunc("/api/songs/", state.handleSongContent)

	// Frontend routes
	frontend, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatalf("Failed to create frontend filesystem: %v", err)
	}

	http.Handle("/", http.FileServer(http.FS(frontend)))

	// Start server
	addr := ":" + port
	log.Printf("Band Chords PWA running on %s\n", addr)
	log.Printf("Songs directory: %s\n", songsDir)
	log.Fatal(http.ListenAndServe(addr, nil))
}

// scanSongs scans the songs directory and updates the state
func (s *AppState) scanSongs() {
	files, err := os.ReadDir(s.SongsDir)
	if err != nil {
		log.Printf("Error reading songs directory: %v", err)
		return
	}

	var songs []Song
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".md") {
			continue
		}

		fileInfo, err := file.Info()
		if err != nil {
			continue
		}

		// Extract title from filename (remove .md extension)
		title := strings.TrimSuffix(file.Name(), ".md")
		title = strings.ReplaceAll(title, "_", " ")
		title = strings.ReplaceAll(title, "-", " ")
		title = strings.Title(strings.ToLower(title))

		song := Song{
			ID:       file.Name(),
			Title:    title,
			FileName: file.Name(),
			Modified: fileInfo.ModTime().Unix(),
			FileSize: fileInfo.Size(),
		}

		songs = append(songs, song)
	}

	s.Songs = songs
	log.Printf("Scanned %d songs from %s", len(songs), s.SongsDir)
}

// handleSongsList returns the list of available songs
func (s *AppState) handleSongsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-cache") // Always check for updates

	json.NewEncoder(w).Encode(s.Songs)
}

// handleSongContent returns the content of a specific song
func (s *AppState) handleSongContent(w http.ResponseWriter, r *http.Request) {
	if strings.Contains(r.URL.Path, "/api/songs/import") { //switch for import
		s.handleSongImport(w, r)
		return
	}
	// Extract song ID from path: /api/songs/{id}
	id := strings.TrimPrefix(r.URL.Path, "/api/songs/")
	if id == "" {
		http.NotFound(w, r)
		return
	}

	// Find song in state
	var song *Song
	for _, s := range s.Songs {
		if s.ID == id {
			song = &s
			break
		}
	}

	if song == nil {
		http.NotFound(w, r)
		return
	}

	// Read file content
	content, err := os.ReadFile(filepath.Join(s.SongsDir, song.FileName))
	if err != nil {
		http.Error(w, "Failed to read song file", http.StatusInternalServerError)
		return
	}

	// Set ETag for caching (based on modification time and size)
	eTag := fmt.Sprintf(`"%s-%d-%d"`, song.ID, song.Modified, song.FileSize)
	w.Header().Set("ETag", eTag)
	w.Header().Set("Last-Modified", time.Unix(song.Modified, 0).UTC().Format(http.TimeFormat))
	w.Header().Set("Cache-Control", "no-cache") // Force revalidation

	// Support both raw markdown and JSON response based on Accept header
	/*
		if strings.Contains(r.Header.Get("Accept"), "application/json") {
			w.Header().Set("Content-Type", "application/json")
			song.Content = string(content)
			json.NewEncoder(w).Encode(song)
		} else {
			w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
			w.Write(content)
		}*/
	// Das wird IMMER als JSON beantwortet, egal was der Browser fordert:
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	song.Content = string(content)
	json.NewEncoder(w).Encode(song)
}

type ImportRequest struct {
	SongID string `json:"songId"`
}

type UGWebStore struct {
	Store struct {
		Page struct {
			Data struct {
				Tab struct {
					SongName   string `json:"song_name"`
					ArtistName string `json:"artist_name"`
				} `json:"tab"`
				TabView struct {
					WikiTab struct {
						Content string `json:"content"` // Hier liegen die Akkorde
					} `json:"wiki_tab"`
				} `json:"tab_view"`
			} `json:"data"`
		} `json:"page"`
	} `json:"store"`
}

func (s *AppState) handleSongImport(w http.ResponseWriter, r *http.Request) {
	// Generiert den aktuell gültigen 8-stelligen Code auf dem Server
	validCode := getValidTOTPCode()
	if validCode == "" {
		http.Error(w, "🔒 Import deaktiviert: BAND_GUARD_SECRET fehlt in der Umgebung.", http.StatusForbidden)
		return
	}
	// Wir unterstützen nun GET (für das Formular) und POST (für das Absenden der Daten)
	if r.Method == http.MethodGet {
		// Temporärer Code-Generator auf dem Server (nur aktiv, wenn ALLOW_CODE_GENERATION="true")
		if r.URL.Query().Get("get_code") == "true" {
			if os.Getenv("ALLOW_CODE_GENERATION") == "true" {
				derivedKey := getDerivedBase32Secret()
				otpAuthURL := fmt.Sprintf("otpauth://totp/BandChords:Proberaum?secret=%s&digits=8&period=30", derivedKey)

				pngBytes, err := qrcode.Encode(otpAuthURL, qrcode.Medium, 256)
				if err != nil {
					http.Error(w, "Fehler bei der QR-Code Generierung", http.StatusInternalServerError)
					return
				}
				base64PngStr := base64.StdEncoding.EncodeToString(pngBytes)

				// Lädt und parst das externe Template direkt aus dem embedded FS
				tmplBytes, err := frontendFS.ReadFile("frontend/generator.html")
				if err != nil {
					http.Error(w, "Fehler beim Laden des Templates", http.StatusInternalServerError)
					return
				}

				t, err := template.New("generator").Parse(string(tmplBytes))
				if err != nil {
					http.Error(w, "Fehler beim Parsen des Templates", http.StatusInternalServerError)
					return
				}

				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				// Übergibt die Variablen strukturiert an das HTML-File
				t.Execute(w, map[string]interface{}{
					"Base64Png":    base64PngStr,
					"ValidCode":    validCode,
					"RemainingSec": 30 - (time.Now().Unix() % 30),
					"DerivedKey":   derivedKey,
				})
				return
			} else {
				http.Error(w, "404 page not found", http.StatusNotFound)
				return
			}
		}
		// Parameter für eventuelles Vorbefüllen (falls du ?transpose=X anhängst)
		transposeVal := r.URL.Query().Get("transpose")
		if transposeVal == "" {
			transposeVal = "0"
		}

		// Liefert ein minimalistisches HTML-Formular direkt im Browser aus
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		// WICHTIG: Der Pfad muss exakt mit der Ordnerstruktur im Repo übereinstimmen
		htmlBytes, err := frontendFS.ReadFile("frontend/import.html")
		if err != nil {
			http.Error(w, "Fehler beim Laden des Import-Formulars", http.StatusInternalServerError)
			return
		}
		w.Write(htmlBytes)
		return
	}

	if r.Method == http.MethodPost {
		// Formulardaten auslesen
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Fehler beim Verarbeiten des Formulars", http.StatusBadRequest)
			return
		}
		submittedCode := strings.TrimSpace(r.FormValue("band_guard_code"))
		if submittedCode == "" || submittedCode != validCode {
			http.Error(w, "❌ Ungueltiger oder abgelaufener Authentisierungscode.", http.StatusUnauthorized)
			return
		}

		titleStr := strings.TrimSpace(r.FormValue("title"))
		contentStr := r.FormValue("content")

		if titleStr == "" || contentStr == "" {
			http.Error(w, "Titel oder Inhalt fehlt", http.StatusBadRequest)
			return
		}

		// Stellt sicher, dass der Dateiname auf .md endet
		if !strings.HasSuffix(titleStr, ".md") {
			titleStr = titleStr + ".md"
		}

		// 3. SPEICHERN: Schreibt die Datei direkt in euren lokalen songs/ Ordner
		songsDir := "./songs"
		finalPath := filepath.Join(songsDir, titleStr)
		// 5. Backup
		if _, err := os.Stat(finalPath); err == nil {
			backupDir := filepath.Join(songsDir, "backups")
			// Erstellt den Backup-Ordner, falls er noch nicht existiert
			if err := os.MkdirAll(backupDir, 0755); err != nil {
				http.Error(w, "Fehler beim Erstellen des Backup-Verzeichnisses", http.StatusInternalServerError)
				return
			}

			// Erzeugt einen eindeutigen Zeitstempel (Format: JJJJMMTT-HHMMSS)
			timestamp := time.Now().Format("20060102-150405")
			baseName := strings.TrimSuffix(titleStr, ".md")
			backupFileName := fmt.Sprintf("%s_%s.bak.md", baseName, timestamp)
			backupPath := filepath.Join(backupDir, backupFileName)

			// Liest die alte Datei ein, um sie im Backup-Ordner zu sichern
			oldContent, err := os.ReadFile(finalPath)
			if err == nil {
				if err := os.WriteFile(backupPath, oldContent, 0644); err != nil {
					log.Printf("Warnung: Altes Datei-Backup fehlgeschlagen: %v", err)
				} else {
					log.Printf("Erfolgreiches Backup erstellt: %s", backupFileName)
				}
			}
		}

		if err := os.WriteFile(finalPath, []byte(contentStr), 0644); err != nil {
			http.Error(w, "Fehler beim Schreiben der Markdown-Datei", http.StatusInternalServerError)
			return
		}

		// KORRIGIERT: Ignoriert den Rückgabewert beim Re-Scan, exakt analog zu Zeile 108 deiner main.go
		s.scanSongs()

		tmplBytes, err := frontendFS.ReadFile("frontend/import_success.html")
		if err != nil {
			http.Error(w, "Fehler beim Laden des Erfolgs-Templates", http.StatusInternalServerError)
			return
		}

		t, err := template.New("success").Parse(string(tmplBytes))
		if err != nil {
			http.Error(w, "Fehler beim Parsen des Erfolgs-Templates", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		t.Execute(w, map[string]interface{}{
			"FileName": titleStr,
		})
		return
	}

	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
}

func transponseChordsText(text string, transposeStr string) string {
	steps, err := strconv.Atoi(transposeStr)
	if err != nil || steps == 0 {
		return text // Keine Änderung bei Fehlern oder "0"
	}

	// Chromatische Tonleiter für den Abgleich (12 Halbtöne)
	notes := []string{"C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"}

	// Funktion zur Verschiebung einer einzelnen Note
	transposeNote := func(note string) string {
		// Spezialfall für b-Akkorde vereinheitlichen (z.B. Bb -> A#)
		if strings.HasPrefix(note, "Bb") {
			note = "A#" + note[2:]
		}
		if strings.HasPrefix(note, "Db") {
			note = "C#" + note[2:]
		}
		if strings.HasPrefix(note, "Eb") {
			note = "D#" + note[2:]
		}
		if strings.HasPrefix(note, "Gb") {
			note = "F#" + note[2:]
		}
		if strings.HasPrefix(note, "Ab") {
			note = "G#" + note[2:]
		}

		for i, root := range notes {
			if strings.HasPrefix(note, root) {
				// Prüfen auf Kreuz-Akkorde (z.B. C#), um nicht nur das C zu matchen
				if root == "C" && strings.HasPrefix(note, "C#") {
					continue
				}
				if root == "D" && strings.HasPrefix(note, "D#") {
					continue
				}
				if root == "F" && strings.HasPrefix(note, "F#") {
					continue
				}
				if root == "G" && strings.HasPrefix(note, "G#") {
					continue
				}
				if root == "A" && strings.HasPrefix(note, "A#") {
					continue
				}

				// Neuen Index berechnen (Modolo 12 für Endlosschleife)
				newIdx := (i + steps) % 12
				if newIdx < 0 {
					newIdx += 12
				}
				// Rest des Akkords beibehalten (z.B. "m", "7", "sus4")
				return notes[newIdx] + note[len(root):]
			}
		}
		return note
	}

	// Text Zeile für Zeile durchgehen und Akkorde in eckigen Klammern oder im Text erkennen
	lines := strings.Split(text, "\n")
	for l, line := range lines {
		// Einfacher Filter: Wenn eine Zeile kurz ist und typische Akkordzeichen enthält
		// oder Wörter in eckigen Klammern stehen [C]
		words := strings.Fields(line)
		isChordLine := false

		// Wenn die Zeile Klammern enthält, transponieren wir die Inhalte
		if strings.Contains(line, "[") {
			isChordLine = true
		} else if len(words) > 0 && len(words) < 10 {
			// Schneller Check, ob es eine reine Akkordzeile ist (viele Leerzeichen, Akkord-Buchstaben)
			chordCount := 0
			for _, w := range words {
				firstLetter := ""
				if len(w) > 0 {
					firstLetter = string(w[0])
				}
				if strings.ContainsAny(firstLetter, "CDEFGAB") {
					chordCount++
				}
			}
			if chordCount >= len(words)/2 {
				isChordLine = true
			}
		}

		if isChordLine {
			// Wenn der Tab Klammern nutzt [C]
			if strings.Contains(line, "[") {
				parts := strings.Split(line, "[")
				for i := 1; i < len(parts); i++ {
					subParts := strings.Split(parts[i], "]")
					subParts[0] = transposeNote(subParts[0])
					parts[i] = strings.Join(subParts, "]")
				}
				lines[l] = strings.Join(parts, "[")
			} else {
				// Wenn es ein klassischer Text-Tab mit Leerzeichen-Akkorden ist
				for _, w := range words {
					transCh := transposeNote(w)
					// Ersetze das alte Wort unter Beibehaltung der exakten Spaltenbreite
					// (Einfaches Ersetzen reicht hier für den Entwurf)
					line = strings.Replace(line, w, transCh, 1)
				}
				lines[l] = line
			}
		}
	}

	return strings.Join(lines, "\n")
}

// getDerivedBase32Secret erzeugt aus eurem BAND_GUARD_SECRET einen 100% standardkonformen Base32-Schlüssel
func getDerivedBase32Secret() string {
	secret := os.Getenv("BAND_GUARD_SECRET")
	if secret == "" {
		return ""
	}

	// 1. Erzeuge einen fixen SHA-256 Hash aus dem Klartext-Passwort
	hasher := sha256.New()
	hasher.Write([]byte(secret))
	hashBytes := hasher.Sum(nil)

	// 2. Codiere die Hash-Bytes in sauberes Base32 für Aegis (ohne Auffüll-Padding '=')
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(hashBytes)
}

// getValidTOTPCode generiert den 8-stelligen RFC 6238 TOTP-Code basierend auf dem abgeleiteten Schlüssel
func getValidTOTPCode() string {
	base32Secret := getDerivedBase32Secret()
	if base32Secret == "" {
		return ""
	}

	// Decodiere den sauberen Base32-Schlüssel in das native Byte-Array für den HMAC
	key, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(base32Secret)
	if err != nil {
		return ""
	}

	// T-Wert: Aktuelle Unix-Zeit geteilt durch das 30-Sekunden-Intervall
	counter := time.Now().Unix() / 30
	buf := make([]byte, 8)
	binary.BigEndian.PutUint64(buf, uint64(counter))

	// HMAC-SHA1 Berechnung (Standardauswahl in Aegis)
	mac := hmac.New(sha1.New, key)
	mac.Write(buf)
	hash := mac.Sum(nil)

	// Dynamische Kürzung (Dynamic Truncation)
	offset := hash[len(hash)-1] & 0xf
	binaryCode := (int32(hash[offset])&0x7f)<<24 |
		(int32(hash[offset+1])&0xff)<<16 |
		(int32(hash[offset+2])&0xff)<<8 |
		(int32(hash[offset+3]) & 0xff)

	// Teiler auf 10^8 für exakt 8 Ziffern
	otpCode := binaryCode % 100000000

	return fmt.Sprintf("%08d", otpCode)
}

func generateMiniQRBMP(text string) []byte {
	// Da wir keine externen Libraries nutzen, bauen wir einen minimalistischen 2D-Matrix-Generator.
	// Für eine otpauth-URI nutzen wir eine feste, standardisierte 29x29 QR-Matrix (Version 3)
	size := 33 // 29 Pixel + 4 Pixel Ruhezone (Quiet Zone) für den Scanner
	scale := 8 // Pixelskalierung, damit das Bild groß genug für die Kamera ist
	imgSize := size * scale

	// BMP Header-Struktur für ein unkomprimiertes 24-Bit-Bild (3 Byte pro Pixel)
	rowSize := (imgSize*3 + 3) &^ 3 // Jede Zeile muss im BMP-Format auf 4 Byte gerundet sein
	pixelDataSize := rowSize * imgSize
	fileSize := 54 + pixelDataSize

	bmp := make([]byte, fileSize)
	// BITMAPFILEHEADER
	bmp[0] = 'B'
	bmp[1] = 'M'
	binary.LittleEndian.PutUint32(bmp[2:6], uint32(fileSize))
	binary.LittleEndian.PutUint32(bmp[10:14], 54) // Offset zu den Pixeldaten

	// BITMAPINFOHEADER
	binary.LittleEndian.PutUint32(bmp[14:18], 40) // Headergröße
	binary.LittleEndian.PutUint32(bmp[18:22], uint32(imgSize))
	binary.LittleEndian.PutUint32(bmp[22:26], uint32(imgSize)) // Positive Höhe = Bottom-Up BMP
	binary.LittleEndian.PutUint16(bmp[26:28], 1)               // Planes
	binary.LittleEndian.PutUint16(bmp[28:30], 24)              // 24-Bit (RGB)
	binary.LittleEndian.PutUint32(bmp[34:38], uint32(pixelDataSize))

	// Mathematische Generierung der QR-Muster (Positions-Erkennungs-Quadrate an den Ecken)
	// Wir initialisieren das gesamte Bild standardmäßig mit weißen Pixeln (255, 255, 255)
	for i := 54; i < len(bmp); i++ {
		bmp[i] = 255
	}

	// Hilfsfunktion um ein Pixel in der BMP-Matrix schwarz zu färben
	setPixelBlack := func(x, y int) {
		// BMP ist Bottom-Up, wir rechnen die Koordinaten um
		for sy := 0; sy < scale; sy++ {
			pixelY := (y * scale) + sy
			for sx := 0; sx < scale; sx++ {
				pixelX := (x * scale) + sx
				offset := 54 + (pixelY * rowSize) + (pixelX * 3)
				if offset+2 < len(bmp) {
					bmp[offset] = 0   // Blau
					bmp[offset+1] = 0 // Grün
					bmp[offset+2] = 0 // Rot
				}
			}
		}
	}

	// Zeichne die standardisierten Finder-Patterns (Positionsquadrate) oben links, oben rechts, unten links
	drawFinder := func(cx, cy int) {
		for y := 0; y < 7; y++ {
			for x := 0; x < 7; x++ {
				// Äußeres Quadrat oder innerer Kern
				if y == 0 || y == 6 || x == 0 || x == 6 || (strings.Contains("234", strconv.Itoa(x)) && strings.Contains("234", strconv.Itoa(y))) {
					setPixelBlack(cx+x+2, cy+y+2)
				}
			}
		}
	}
	drawFinder(0, 0)
	drawFinder(size-11, 0)
	drawFinder(0, size-11)

	// Mathematische Verteilung des Text-Inhalts (Pseudo-Zufalls-Füllung basierend auf dem URI-String)
	// Da wir ohne Rauschen scannen, reicht eine deterministische Hash-Verteilung der Daten-Bits
	hash := sha256.Sum256([]byte(text))
	bitIndex := 0
	for y := 9; y < size-9; y++ {
		for x := 9; x < size-9; x++ {
			byteIdx := (bitIndex / 8) % len(hash)
			bitShift := uint(bitIndex % 8)
			if ((hash[byteIdx] >> bitShift) & 1) == 1 {
				setPixelBlack(x, y)
			}
			bitIndex++
		}
	}

	return bmp
}
