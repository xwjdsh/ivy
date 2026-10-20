package main

import (
	"bufio"
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReadEvents(t *testing.T) {
	stream := "event: connected\ndata: {}\n\n: ping\n\nevent: reminder\ndata: {\"title\":\"Pick up the parcel\"}\n\ndata: plain\n\n"
	var got []event
	if err := readEvents(bufio.NewScanner(strings.NewReader(stream)), func(e event) { got = append(got, e) }); err != nil {
		t.Fatal(err)
	}
	want := []event{
		{Type: "connected", Data: []byte("{}")},
		{Type: "reminder", Data: []byte(`{"title":"Pick up the parcel"}`)},
		{Type: "message", Data: []byte("plain")},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d events, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i].Type != want[i].Type || string(got[i].Data) != string(want[i].Data) {
			t.Errorf("event %d = %s %s, want %s %s", i, got[i].Type, got[i].Data, want[i].Type, want[i].Data)
		}
	}
}

// A daemon stand-in on a Unix socket: /health, and an event stream of two events.
func fakeDaemon(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ivy") // short: socket paths are limited to ~100 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	socket := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", socket)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"ok":true}`)) })
	mux.HandleFunc("/events", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		w.Write([]byte("event: connected\ndata: {}\n\nevent: reminder\ndata: {\"id\":\"m:1\",\"title\":\"Rent\"}\n\n"))
	})
	srv := &http.Server{Handler: mux}
	go srv.Serve(ln)
	t.Cleanup(func() { srv.Close() })
	return socket
}

func TestHealthyAndFollowEvents(t *testing.T) {
	socket := fakeDaemon(t)
	if !healthy(socket) {
		t.Fatal("healthy() = false for a live daemon")
	}
	if healthy(socket + ".missing") {
		t.Fatal("healthy() = true with no daemon")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var types []string
	if err := followEvents(ctx, socket, func(e event) { types = append(types, e.Type) }); err != nil {
		t.Fatal(err)
	}
	if strings.Join(types, ",") != "connected,reminder" {
		t.Fatalf("events = %v", types)
	}
}

func TestIvyHome(t *testing.T) {
	t.Setenv("IVY_HOME", "/tmp/ivy-home")
	if got := socketPath(); got != "/tmp/ivy-home/daemon.sock" {
		t.Fatalf("socketPath() = %s", got)
	}
	t.Setenv("IVY_HOME", "")
	home, _ := os.UserHomeDir()
	if got := ivyHome(); got != filepath.Join(home, ".ivy") {
		t.Fatalf("ivyHome() = %s", got)
	}
}
