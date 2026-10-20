package main

import (
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// supervisor keeps `ivy daemon` running: it starts the daemon, restarts it when it stops
// (waiting longer after each quick failure), and stops it when the app quits. A daemon
// already answering on the socket, say one started by hand, is used as it is and left
// running.
type supervisor struct {
	bin     string // the ivy binary
	logPath string // where the daemon's output goes
	// onChange reports what the supervisor is doing, for the menu: "", or why the daemon
	// isn't running.
	onChange func(problem string)

	mu       sync.Mutex
	cmd      *exec.Cmd
	stopping bool
	done     chan struct{}
}

const (
	minBackoff = time.Second
	maxBackoff = 30 * time.Second
	// A daemon that ran this long before stopping isn't failing to start: retry at once.
	healthyRun = time.Minute
)

func newSupervisor(bin, logPath string, onChange func(string)) *supervisor {
	return &supervisor{bin: bin, logPath: logPath, onChange: onChange, done: make(chan struct{})}
}

func (s *supervisor) run() {
	defer close(s.done)
	backoff := minBackoff
	for !s.isStopping() {
		if healthy(socketPath()) {
			// Someone else's daemon: watch it, and take over if it goes.
			s.onChange("")
			time.Sleep(5 * time.Second)
			continue
		}
		started := time.Now()
		err := s.runOnce()
		if s.isStopping() {
			return
		}
		if time.Since(started) > healthyRun {
			backoff = minBackoff
		}
		problem := "Ivy's daemon stopped"
		if err != nil {
			problem = fmt.Sprintf("Ivy's daemon stopped: %v", err)
		}
		log.Printf("%s; restarting in %s", problem, backoff)
		s.onChange(problem)
		time.Sleep(backoff)
		backoff = min(backoff*2, maxBackoff)
	}
}

// runOnce starts the daemon and waits for it to exit.
func (s *supervisor) runOnce() error {
	out, err := os.OpenFile(s.logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	cmd := exec.Command(s.bin, "daemon")
	cmd.Env = append(os.Environ(), "IVY_HOME="+ivyHome())
	cmd.Stdout, cmd.Stderr = out, out
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return nil
	}
	if err := cmd.Start(); err != nil {
		s.mu.Unlock()
		return err
	}
	s.cmd = cmd
	s.mu.Unlock()
	log.Printf("started ivy daemon (pid %d)", cmd.Process.Pid)
	s.onChange("")
	err = cmd.Wait()
	s.mu.Lock()
	s.cmd = nil
	s.mu.Unlock()
	return err
}

func (s *supervisor) isStopping() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopping
}

// stop ends the daemon this app started (SIGTERM, then SIGKILL after 3 s) and waits for
// the supervisor to finish. A daemon someone else started keeps running.
func (s *supervisor) stop() {
	s.mu.Lock()
	s.stopping = true
	cmd := s.cmd
	s.mu.Unlock()
	if cmd != nil && cmd.Process != nil {
		if err := cmd.Process.Signal(syscall.SIGTERM); err != nil && !errors.Is(err, os.ErrProcessDone) {
			log.Printf("stopping the daemon: %v", err)
		}
		select {
		case <-s.done:
			return
		case <-time.After(3 * time.Second):
			_ = cmd.Process.Kill()
		}
	}
	select {
	case <-s.done:
	case <-time.After(6 * time.Second): // asleep in a backoff or watching another daemon
	}
}
