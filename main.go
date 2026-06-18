package main

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
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
	// Wir unterstützen nun GET (für das Formular) und POST (für das Absenden der Daten)
	if r.Method == http.MethodGet {
		// Parameter für eventuelles Vorbefüllen (falls du ?transpose=X anhängst)
		transposeVal := r.URL.Query().Get("transpose")
		if transposeVal == "" {
			transposeVal = "0"
		}

		// Liefert ein minimalistisches HTML-Formular direkt im Browser aus
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `
			<!DOCTYPE html>
			<html>
			<head>
				<title>Song Import / Copy-Paste</title>
				<style>
					body { font-family: sans-serif; background: #1e222b; color: #f5f6fa; padding: 20px; max-width: 600px; margin: 0 auto; }
					input, textarea { width: 100%%; padding: 10px; background: #2f3542; border: 1px solid #4b5563; color: #fff; border-radius: 6px; box-sizing: border-box; margin-bottom: 15px; font-size: 16px; }
					textarea { font-family: monospace; height: 300px; }
					button { background: #ff4757; color: white; border: none; padding: 12px 20px; border-radius: 6px; cursor: pointer; font-size: 16px; width: 100%%; font-weight: bold; }
					button:hover { background: #ff6b81; }
					label { font-weight: bold; display: block; margin-bottom: 5px; color: #a4b0be; }
				</style>
			</head>
			<body>
				<h1>📥 Neuer Song Import</h1>
				<form action="/api/songs/import" method="POST">
					<label>Künstler / Band:</label>
					<input type="text" name="artist" placeholder="z.B. Oasis" required>

					<label>Song Titel:</label>
					<input type="text" name="title" placeholder="z.B. Wonderwall" required>

					<label>Transponieren (Halbtöne, z.B. -3 oder 2):</label>
					<input type="number" name="transpose" value="%s" min="-12" max="12" required>

					<label>Akkorde & Text hier hineinkopieren:</label>
					<textarea name="chords" placeholder="Füge hier den Songtext mit den Akkorden ein..." required></textarea>

					<button type="submit">💾 Song für die Band speichern</button>
				</form>
			</body>
			</html>
		`, transposeVal)
		return
	}

	if r.Method == http.MethodPost {
		// Formulardaten auslesen
		if err := r.ParseForm(); err != nil {
			http.Error(w, "Fehler beim Verarbeiten des Formulars", http.StatusBadRequest)
			return
		}

		artistName := r.FormValue("artist")
		songName := r.FormValue("title")
		transposeVal := r.FormValue("transpose")
		rawContent := r.FormValue("chords")

		// ABSICHERUNG: Keine leeren Daten erlauben
		if artistName == "" || songName == "" || rawContent == "" {
			http.Error(w, "Bitte alle Felder ausfüllen!", http.StatusBadRequest)
			return
		}
		if transposeVal == "" {
			transposeVal = "0"
		}

		// Serverseitiges Transponieren der hineinkopierten Akkorde ausführen
		finalChords := transponseChordsText(rawContent, transposeVal)

		suffix := ""
		if transposeVal != "0" {
			suffix = "_trans_" + strings.ReplaceAll(transposeVal, "-", "minus")
		}

		// Das finale Markdown zusammenbauen
		markdownContent := fmt.Sprintf("# %s - %s\n\n**Tempo:** 90 BPM\n\n%s",
			artistName,
			songName,
			finalChords,
		)

		// Dateinamen absolut sicher und sauber generieren
		safeTitle := strings.ToLower(fmt.Sprintf("%s_%s%s", artistName, songName, suffix))
		safeTitle = strings.ReplaceAll(safeTitle, " ", "_")
		safeTitle = strings.Map(func(r rune) rune {
			if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '_' {
				return r
			}
			return -1
		}, safeTitle) + ".md"

		// Datei auf der Festplatte im ./songs Ordner sichern
		filePath := filepath.Join(s.SongsDir, safeTitle)
		if err := os.WriteFile(filePath, []byte(markdownContent), 0644); err != nil {
			log.Printf("❌ FEHLER beim Schreiben der Datei: %v", err)
			http.Error(w, "Datei konnte nicht auf dem Server gespeichert werden.", http.StatusInternalServerError)
			return
		}

		// Den internen Go-Verzeichnis-Scan triggern, damit das Lied sofort existiert
		s.scanSongs()

		// Erfolgsmeldung im Browser ausgeben
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `
			<h1>🎉 Erfolgreich gespeichert!</h1>
			<p>Der Song <b>%s - %s</b> wurde im Band-Ordner hinterlegt.</p>
			<p>Er synchronisiert sich jetzt automatisch im Hintergrund auf alle Tablets.</p>
			<br>
			<a href="/api/songs/import" style="padding: 10px 15px; background: #ff4757; color: white; text-decoration: none; border-radius: 6px; font-weight: bold;">➕ Weiteren Song hinzufügen</a>
		`, artistName, songName)
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
