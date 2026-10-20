package main

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"github.com/egoist/mygo"
)

// The chat window shows the app's web page (packages/web, the app's frontend, embedded by
// `mygo build`), so the interface is TypeScript like the rest of Ivy (DESIGN.md §5.7). The
// page talks to the daemon through ivy://, a scheme of the app's own whose every request
// this app forwards to the daemon's socket: the daemon listens on no TCP port, and nothing
// else can reach it this way.
const daemonScheme = "ivy"

// daemonProxy forwards a request of the page to the daemon, streaming the response as it
// comes (the event stream stays open).
func daemonProxy(socket string) http.Handler {
	daemon := &url.URL{Scheme: "http", Host: "ivy"}
	proxy := &httputil.ReverseProxy{
		Rewrite:       func(r *httputil.ProxyRequest) { r.SetURL(daemon) },
		Transport:     unixTransport(socket),
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"error":"Ivy's daemon isn't running"}`))
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// mygo hands the page's request over with its body but no length, and the proxy
		// takes a length of 0 for no body and drops it: read it here and set its length.
		if r.Body != nil && r.ContentLength <= 0 {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, `{"error":"Couldn't read the request"}`, http.StatusBadRequest)
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
		}
		proxy.ServeHTTP(w, r)
	})
}

// chatWindow is the one chat window, or nil while it is closed. It is only used on the
// main thread, where menu clicks, notification clicks and window events run.
var chatWindow *mygo.Window

// openChat shows the chat window, opening it if it is closed. While it is open Ivy has a
// Dock icon, as a window of a regular app; closed, Ivy is back in the menu bar alone.
func openChat() {
	mygo.App.SetActivationPolicy(mygo.ActivationPolicyRegular)
	if w := chatWindow; w != nil {
		w.Show()
		w.Focus()
		mygo.App.Focus()
		return
	}
	w := mygo.NewWindow(mygo.WindowOptions{
		Title:     "Ivy",
		URL:       "/", // the frontend's page
		Width:     960,
		Height:    680,
		MinWidth:  560,
		MinHeight: 400,
		StateKey:  "chat",
		Hidden:    true, // shown once the page paints, without a white flash
		// The controls sit over the page's top bar, which keeps clear of them.
		TitleBarStyle: mygo.TitleBarHiddenInset,
	})
	chatWindow = w
	w.OnReadyToShow(func() {
		w.Show()
		mygo.App.Focus()
	})
	// Links in replies open in the browser, not in place of the chat.
	w.Page().OnWillNavigate(func(e *mygo.NavigateEvent) {
		if !isFrontend(e.URL) {
			e.PreventDefault()
			if err := mygo.Shell.OpenExternal(e.URL); err != nil {
				log.Printf("open %s: %v", e.URL, err)
			}
		}
	})
	w.OnClosed(func() {
		if chatWindow == w {
			chatWindow = nil
			mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
		}
	})
}

// isFrontend tells whether a URL is a page of the app's frontend: mygo://, or the dev
// server under `mygo dev`.
func isFrontend(u string) bool {
	return strings.HasPrefix(u, "mygo:") || mygo.IsDev() && strings.HasPrefix(u, "http://localhost:")
}
