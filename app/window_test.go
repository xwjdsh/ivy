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
		daemonProxy(socket, noProblem).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, daemonScheme+"://localhost"+path, nil))
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
	daemonProxy(fakeDaemon(t), noProblem).ServeHTTP(rec, put)
	if body := rec.Body.String(); body != `{"effort":"high"}` {
		t.Fatalf("forwarded body: %d %q", rec.Code, body)
	}
	// No daemon: the page is told so, and why when the app knows.
	if code, body := get("/nonexistent.sock", "/sessions"); code != http.StatusBadGateway || !strings.Contains(body, `"error":"Ivy's daemon isn't running"`) {
		t.Fatalf("request without a daemon: %d %s", code, body)
	}
	rec = httptest.NewRecorder()
	why := func() string { return "the ivy binary is missing" }
	daemonProxy("/nonexistent.sock", why).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, daemonScheme+"://localhost/sessions", nil))
	if body := rec.Body.String(); !strings.Contains(body, "isn't running: the ivy binary is missing") {
		t.Fatalf("request without a daemon, with a reason: %s", body)
	}
}

func noProblem() string { return "" }

func TestAppearance(t *testing.T) {
	serve := func(method, body string) (int, string) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, daemonScheme+"://localhost"+appearancePath, strings.NewReader(body))
		// Answered by the app, never forwarded: there is no daemon here.
		schemeHandler("/nonexistent.sock", noProblem).ServeHTTP(rec, req)
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

func TestOpenNamesOnly(t *testing.T) {
	post := func(body string) int {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, daemonScheme+"://localhost/app/open", strings.NewReader(body))
		schemeHandler("/nonexistent.sock", noProblem).ServeHTTP(rec, req)
		return rec.Code
	}
	// A path from the page is never opened: only the names the app knows.
	if code := post(`{"what":"/etc/passwd"}`); code != http.StatusBadRequest {
		t.Fatalf("open of a path: %d", code)
	}
	if code := post(`not json`); code != http.StatusBadRequest {
		t.Fatalf("open without JSON: %d", code)
	}
}
