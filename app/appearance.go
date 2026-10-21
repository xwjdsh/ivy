package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

// The app's light or dark appearance: the system's, or one the user picked in the chat
// window. It is the app's own setting, not Ivy's: the app answers it on ivy:// itself
// (appearancePath) instead of forwarding it to the daemon, and keeps it in a file of its
// own. The page follows it through prefers-color-scheme, the title bar and menus with it.
const appearancePath = "/app/appearance"

// appearanceFile keeps the choice: "system", "light" or "dark".
func appearanceFile() string {
	dir, err := mygo.App.Path(mygo.PathUserData)
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "appearance")
}

// validAppearance tells whether s names an appearance.
func validAppearance(s string) bool {
	switch mygo.ThemeSource(s) {
	case mygo.ThemeSystem, mygo.ThemeLight, mygo.ThemeDark:
		return true
	}
	return false
}

// loadAppearance applies the saved choice; before App.Run, so the window opens in it.
func loadAppearance() {
	b, err := os.ReadFile(appearanceFile())
	if s := strings.TrimSpace(string(b)); err == nil && validAppearance(s) {
		mygo.Theme.SetSource(mygo.ThemeSource(s))
	}
}

// appearance is the body of appearancePath's requests and responses.
type appearance struct {
	Appearance string `json:"appearance"`
}

// appearanceHandler answers GET (the current choice) and PUT (a new one, applied and saved).
func appearanceHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var a appearance
		body, _ := io.ReadAll(r.Body)
		if json.Unmarshal(body, &a) != nil || !validAppearance(a.Appearance) {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"The appearance is system, light or dark"}`))
			return
		}
		mygo.Theme.SetSource(mygo.ThemeSource(a.Appearance))
		if file := appearanceFile(); file != "" {
			if err := os.WriteFile(file, []byte(a.Appearance+"\n"), 0o600); err != nil {
				log.Printf("appearance: %v", err) // applied until the app quits
			}
		}
	default:
		w.WriteHeader(http.StatusMethodNotAllowed)
		w.Write([]byte(`{"error":"GET or PUT"}`))
		return
	}
	json.NewEncoder(w).Encode(appearance{Appearance: string(mygo.Theme.Source())})
}
