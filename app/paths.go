package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/egoist/mygo"
)

// devApp reports whether this is the development app, "Ivy Dev" (`mygo dev`, or a build not
// meant to be installed): it keeps its own folder, daemon and command apart from the user's
// Ivy, as the `ivy` it ships does (RELEASE in packages/kernel/src/config.ts).
func devApp() bool { return strings.HasSuffix(mygo.App.Name(), " Dev") }

// ivyHome is Ivy's folder: IVY_HOME when set, else ~/.ivy, or ~/.ivy-dev for the development
// app. The daemon is started with it, so both agree.
func ivyHome() string {
	if home := os.Getenv("IVY_HOME"); home != "" {
		if abs, err := filepath.Abs(home); err == nil {
			return abs
		}
		return home
	}
	dir, err := os.UserHomeDir()
	if err != nil {
		return ".ivy"
	}
	if devApp() {
		return filepath.Join(dir, ".ivy-dev")
	}
	return filepath.Join(dir, ".ivy")
}

// socketPath is where the daemon listens: resolvePaths' daemonSocket in packages/kernel.
func socketPath() string { return filepath.Join(ivyHome(), "daemon.sock") }

// maxSocketPath is the longest Unix socket path macOS takes, in bytes; the daemon checks
// the same (MAX_SOCKET_PATH in packages/daemon/src/server.ts).
const maxSocketPath = 103

// socketProblem says why the socket can't be used, or "".
func socketProblem() string {
	if n := len(socketPath()); n > maxSocketPath {
		return fmt.Sprintf("IVY_HOME is too long for the daemon's socket (%d bytes; macOS allows %d)", n, maxSocketPath)
	}
	return ""
}
