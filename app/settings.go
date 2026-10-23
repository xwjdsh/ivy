package main

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os/exec"
	"path/filepath"

	"github.com/egoist/mygo"
)

// The app's own settings, which the settings page reads and changes on ivy:// under /app/,
// answered here instead of by the daemon (DESIGN.md §5.7): the appearance (appearance.go),
// starting at login, the `ivy` command, and opening Ivy's files and folders.

// appRoutes are the requests under /app/ the app answers itself.
var appRoutes = map[string]http.HandlerFunc{
	appearancePath: appearanceHandler,
	"/app/login":   loginHandler,
	"/app/command": commandHandler,
	"/app/open":    openHandler,
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// readJSON reads a request's body into v; false (and the reply written) if it can't.
func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	body, _ := io.ReadAll(r.Body)
	if err := json.Unmarshal(body, v); err != nil {
		writeError(w, http.StatusBadRequest, "The body isn't JSON")
		return false
	}
	return true
}

// loginHandler answers GET (whether Ivy starts at login) and PUT (turn it on or off).
func loginHandler(w http.ResponseWriter, r *http.Request) {
	type login struct {
		Enabled bool `json:"enabled"`
	}
	switch r.Method {
	case http.MethodGet:
	case http.MethodPut:
		var l login
		if !readJSON(w, r, &l) {
			return
		}
		if err := mygo.App.SetOpenAtLogin(l.Enabled); err != nil {
			log.Printf("start at login: %v", err)
			writeError(w, http.StatusInternalServerError, "Couldn't change starting at login: "+err.Error())
			return
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "GET or PUT")
		return
	}
	writeJSON(w, http.StatusOK, login{Enabled: mygo.App.OpenAtLogin()})
}

// commandHandler answers GET (whether the `ivy` command leads to this app) and POST
// (install it, asking for an administrator's password if need be).
func commandHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
	case http.MethodPost:
		if err := linkCommand(); err != nil {
			log.Printf("install command: %v", err)
			writeError(w, http.StatusInternalServerError, "Couldn't install the ivy command: "+err.Error())
			return
		}
	default:
		writeError(w, http.StatusMethodNotAllowed, "GET or POST")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"installed": commandInstalled(), "path": commandLink()})
}

// openHandler opens one of Ivy's files or folders, named, never a path from the page: the
// config in the user's text editor, the data folder or the logs in Finder.
func openHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "POST")
		return
	}
	var what struct {
		What string `json:"what"`
	}
	if !readJSON(w, r, &what) {
		return
	}
	var args []string
	switch what.What {
	case "config":
		args = []string{"-t", filepath.Join(ivyHome(), "config.toml")}
	case "home":
		args = []string{ivyHome()}
	case "logs":
		logs, err := mygo.App.Path(mygo.PathLogs)
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		args = []string{logs}
	default:
		writeError(w, http.StatusBadRequest, "Open config, home or logs")
		return
	}
	if out, err := exec.Command("open", args...).CombinedOutput(); err != nil {
		writeError(w, http.StatusInternalServerError, "Couldn't open it: "+string(out))
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
