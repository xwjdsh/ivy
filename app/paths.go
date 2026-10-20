package main

import (
	"fmt"
	"os"
	"path/filepath"
)

// ivyHome is Ivy's folder: IVY_HOME when set, else ~/.ivy, the same rule as the kernel's
// resolvePaths. An app started from Finder has no IVY_HOME, so it uses ~/.ivy.
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
	return filepath.Join(dir, ".ivy")
}

// socketPath is where the daemon listens (see packages/daemon).
func socketPath() string { return filepath.Join(ivyHome(), "daemon.sock") }

// maxSocketPath is the longest Unix socket path macOS takes, in bytes.
const maxSocketPath = 103

// socketProblem says why the socket can't be used, or "".
func socketProblem() string {
	if n := len(socketPath()); n > maxSocketPath {
		return fmt.Sprintf("IVY_HOME is too long for the daemon's socket (%d bytes; macOS allows %d)", n, maxSocketPath)
	}
	return ""
}
