package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// event is one Server-Sent Event from the daemon, e.g. a `reminder`.
type event struct {
	Type string
	Data json.RawMessage
}

// reminder is the data of a `reminder` event: ReminderEvent in packages/protocol, which
// says what the daemon sends. The app reads only these fields.
type reminder struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Plugin string `json:"plugin"`
}

// unixClient talks HTTP to the daemon over its socket; the host in URLs is ignored.
func unixClient(socket string, timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		},
	}
}

// healthy tells whether a daemon answers on the socket.
func healthy(socket string) bool {
	res, err := unixClient(socket, time.Second).Get("http://ivy/health")
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// followEvents reads the daemon's event stream until it ends or ctx is done, calling
// onEvent for each event. The first is `connected`; comment lines (heartbeats) are skipped.
func followEvents(ctx context.Context, socket string, onEvent func(event)) error {
	// notify=1 (NOTIFY_PARAM in packages/protocol): this client shows reminders, so the
	// daemon sends them here and announces them only while such a client is connected.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://ivy/events?notify=1", nil)
	if err != nil {
		return err
	}
	res, err := unixClient(socket, 0).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("events: %s", res.Status)
	}
	return readEvents(bufio.NewScanner(res.Body), onEvent)
}

// readEvents parses a Server-Sent Events stream: `event:` and `data:` lines, a blank line
// ending each event.
func readEvents(lines *bufio.Scanner, onEvent func(event)) error {
	lines.Buffer(make([]byte, 64*1024), 1024*1024)
	var typ string
	var data []string
	for lines.Scan() {
		line := lines.Text()
		switch {
		case line == "":
			if typ != "" || len(data) > 0 {
				if typ == "" {
					typ = "message"
				}
				onEvent(event{Type: typ, Data: json.RawMessage(strings.Join(data, "\n"))})
			}
			typ, data = "", nil
		case strings.HasPrefix(line, ":"):
			// a comment: the heartbeat
		case strings.HasPrefix(line, "event:"):
			typ = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			data = append(data, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	return lines.Err()
}
