package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDaemonProxy(t *testing.T) {
	get := func(socket, path string) (int, string) {
		rec := httptest.NewRecorder()
		daemonProxy(socket).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, daemonScheme+"://localhost"+path, nil))
		body, _ := io.ReadAll(rec.Result().Body)
		return rec.Code, string(body)
	}
	if code, body := get(fakeDaemon(t), "/health"); code != http.StatusOK || !strings.Contains(body, `"pid":42`) {
		t.Fatalf("forwarded /health: %d %s", code, body)
	}
	// A body comes from mygo with no length; it reaches the daemon all the same.
	put := httptest.NewRequest(http.MethodPut, daemonScheme+"://localhost/echo", strings.NewReader(`{"effort":"high"}`))
	put.ContentLength = 0
	rec := httptest.NewRecorder()
	daemonProxy(fakeDaemon(t)).ServeHTTP(rec, put)
	if body := rec.Body.String(); body != `{"effort":"high"}` {
		t.Fatalf("forwarded body: %d %q", rec.Code, body)
	}
	// No daemon: the page is told why.
	if code, body := get("/nonexistent.sock", "/sessions"); code != http.StatusBadGateway || !strings.Contains(body, `"error"`) {
		t.Fatalf("request without a daemon: %d %s", code, body)
	}
}

func TestAppearance(t *testing.T) {
	serve := func(method, body string) (int, string) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, daemonScheme+"://localhost"+appearancePath, strings.NewReader(body))
		// Answered by the app, never forwarded: there is no daemon here.
		schemeHandler("/nonexistent.sock").ServeHTTP(rec, req)
		return rec.Code, strings.TrimSpace(rec.Body.String())
	}
	if code, body := serve(http.MethodGet, ""); code != http.StatusOK || body != `{"appearance":"system"}` {
		t.Fatalf("GET: %d %s", code, body)
	}
	if code, _ := serve(http.MethodPut, `{"appearance":"sepia"}`); code != http.StatusBadRequest {
		t.Fatalf("PUT of an unknown appearance: %d", code)
	}
	if code, _ := serve(http.MethodDelete, ""); code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE: %d", code)
	}
}
