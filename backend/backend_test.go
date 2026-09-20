package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testPNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII="

func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func fixtureGallery() Gallery {
	return Gallery{
		Workspaces: []Workspace{{ID: "space", Name: "摄影", CreatedAt: 1}, {ID: "empty", Name: "空工作区", CreatedAt: 1}},
		Tasks:      []Task{{ID: "task", Provider: "openai", Model: "gpt-image", Prompt: "红色相机", Params: Params{Count: 2, OutputFormat: "png"}, Status: "done", CreatedAt: 2, Favorite: true, WorkspaceID: "space", Images: []string{testPNG}, ReferenceImages: []ReferenceImage{{ID: "ref", Name: "参考.png", DataURL: testPNG}}}},
	}
}

func TestStoreRoundTripAndFailedWrites(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	g, rev, err := s.saveGallery(ctx, fixtureGallery(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(g.Tasks[0].Images[0], imagePrefix) || g.Tasks[0].Images[0] != g.Tasks[0].ReferenceImages[0].DataURL {
		t.Fatal("images must be persisted and deduplicated")
	}
	settings := Settings{Global: ProviderConfig{BaseURL: "https://example.test", APIKey: "saved-secret"}}
	if err = s.update(func(next *State) error {
		next.Settings = settings
		next.LastWorkspace = "space"
		next.ModelSelections = map[string]string{"openai": "gpt-image", "gemini": "custom"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(reopened.snapshot(), s.snapshot()) {
		t.Fatal("JSON restart lost data")
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "state.json"))
	if err != nil || bytes.Contains(raw, []byte("base64")) {
		t.Fatal("JSON must contain metadata, not image bytes", err)
	}
	image, mime, err := s.imageBytes(ctx, g.Tasks[0].Images[0])
	expected, _ := base64.StdEncoding.DecodeString(strings.Split(testPNG, ",")[1])
	if err != nil || mime != "image/png" || !bytes.Equal(image, expected) {
		t.Fatal("image bytes changed", err)
	}
	broken := fixtureGallery()
	broken.Tasks[0].Images = []string{"data:image/png;base64,broken"}
	if _, _, err = s.saveGallery(ctx, broken, rev); err == nil {
		t.Fatal("invalid image accepted")
	}
	if !reflect.DeepEqual(s.snapshot().Gallery, g) {
		t.Fatal("failed save replaced committed state")
	}
	if _, sameRevision, err := s.saveGallery(ctx, fixtureGallery(), rev); err != nil || sameRevision != rev {
		t.Fatal("unchanged save invalidated another window", err)
	}
	changed := fixtureGallery()
	changed.Tasks[0].Favorite = false
	if _, _, err = s.saveGallery(ctx, changed, 0); !errors.Is(err, errConflict) {
		t.Fatal("stale writer accepted", err)
	}
	// Force the atomic rename to fail without relying on OS permission semantics.
	path := filepath.Join(s.dir, "state.json")
	if err = os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err = s.update(func(next *State) error { next.LastWorkspace = "lost"; return nil }); err == nil {
		t.Fatal("expected write failure")
	}
	if s.snapshot().LastWorkspace != "space" {
		t.Fatal("write failure changed memory")
	}
	if err = os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(path+".saved", path); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.saveGallery(ctx, Gallery{Tasks: []Task{}, Workspaces: []Workspace{}}, rev); err != nil {
		t.Fatal("save did not recover", err)
	}
}

func TestCorruptStateAndInterruptedTask(t *testing.T) {
	s := newTestStore(t)
	g := fixtureGallery()
	g.Tasks[0].Status = "running"
	if _, _, err := s.saveGallery(context.Background(), g, 0); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(s.dir)
	if err != nil || reopened.snapshot().Gallery.Tasks[0].Status != "error" {
		t.Fatal("interrupted task was not recovered", err)
	}
	path := filepath.Join(s.dir, "state.json")
	if err = os.WriteFile(path, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = openStore(s.dir); err == nil {
		t.Fatal("corrupt state accepted")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "broken" {
		t.Fatal("corrupt data was overwritten")
	}
}

func TestMigrationMergesAndIsIdempotent(t *testing.T) {
	s := newTestStore(t)
	legacy := defaultState()
	legacy.Gallery = fixtureGallery()
	legacy.Settings.Global.APIKey = "legacy-key"
	legacy.LastWorkspace = "space"
	if err := s.migrate(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	if s.snapshot().Settings.Global.APIKey != "legacy-key" || s.snapshot().LastWorkspace != "space" {
		t.Fatal("legacy preferences lost")
	}
	// Deleting a migrated task must not resurrect it on a repeated migration.
	state := s.snapshot()
	if _, _, err := s.saveGallery(context.Background(), Gallery{Tasks: []Task{}, Workspaces: state.Gallery.Workspaces}, state.GalleryRevision); err != nil {
		t.Fatal(err)
	}
	if err := s.migrate(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	if len(s.snapshot().Gallery.Tasks) != 0 {
		t.Fatal("repeated migration resurrected a task")
	}
	legacy.Gallery = fixtureGallery()
	legacy.Gallery.Workspaces[0].Name = "不同的工作区"
	legacy.Gallery.Tasks[0].ID = "other"
	legacy.Settings.Global.APIKey = "do-not-overwrite"
	if err := s.migrate(context.Background(), legacy); err != nil {
		t.Fatal(err)
	}
	state = s.snapshot()
	if state.Settings.Global.APIKey != "legacy-key" || state.Gallery.Tasks[0].WorkspaceID == "space" || len(state.Gallery.Workspaces) != 3 {
		t.Fatal("migration overwrite or collision")
	}
}

func configure(t *testing.T, store *Store, target string) {
	t.Helper()
	if err := store.update(func(next *State) error {
		next.Settings.Global = ProviderConfig{BaseURL: target, APIKey: "global-key"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAIModelsGenerationRetriesAndRemoteDownload(t *testing.T) {
	s := newTestStore(t)
	calls := 0
	var upstream *httptest.Server
	upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/image.png" {
			if r.Header.Get("Authorization") != "" {
				t.Error("API key leaked to image host")
			}
			data, _ := base64.StdEncoding.DecodeString(strings.Split(testPNG, ",")[1])
			_, _ = w.Write(data)
			return
		}
		if r.Header.Get("Authorization") != "Bearer global-key" {
			t.Error("missing configured credentials")
		}
		switch r.URL.Path {
		case "/v1/models":
			sendJSON(w, 200, map[string]any{"data": []map[string]string{{"id": "gpt-image-one"}, {"id": "text-model"}, {"id": "gemini-image"}, {"id": "gpt-image-one"}, {"name": "gpt-image-two"}}})
		case "/v1/images/generations":
			calls++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["n"] != float64(1) || body["output_format"] != "webp" || body["prompt"] != "test" {
				t.Error("generation parameters changed", body)
			}
			if calls <= 2 || calls == 4 {
				sendJSON(w, 503, map[string]any{"error": map[string]string{"message": "temporary"}})
				return
			}
			sendJSON(w, 200, map[string]any{"data": []map[string]string{{"url": upstream.URL + "/image.png"}}})
		default:
			t.Error("unexpected upstream path", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	configure(t, s, upstream.URL+"/v1/")
	models, err := availableModels(context.Background(), s.snapshot().Settings, "openai")
	if err != nil || !reflect.DeepEqual(models, []string{"gpt-image-one", "gpt-image-two"}) {
		t.Fatal(models, err)
	}
	images, err := s.generate(context.Background(), GenerationRequest{Provider: "openai", Model: "custom/gpt-image", Prompt: "test", Params: Params{Count: 3, OutputFormat: "webp"}})
	if err != nil || len(images) != 2 || calls != 5 {
		t.Fatal("retry / partial success changed", images, calls, err)
	}
	if !strings.HasPrefix(images[0], imagePrefix) {
		t.Fatal("remote image was not stored locally")
	}
}

func TestReferenceImagesAndGemini(t *testing.T) {
	s := newTestStore(t)
	var paths []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		paths = append(paths, r.URL.Path)
		if r.URL.Path == "/v1/images/edits" {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return
			}
			defer r.MultipartForm.RemoveAll()
			if r.FormValue("n") != "1" || r.FormValue("model") != "gpt-image" || r.FormValue("background") != "transparent" {
				t.Error("multipart parameters lost")
			}
			files := r.MultipartForm.File["image[]"]
			if len(files) != 1 || files[0].Header.Get("Content-Type") != "image/png" {
				t.Error("invalid reference upload")
				return
			}
			file, err := files[0].Open()
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if base64.StdEncoding.EncodeToString(data) != strings.Split(testPNG, ",")[1] {
				t.Error("reference bytes changed")
			}
			sendJSON(w, 200, map[string]any{"data": []map[string]string{{"b64_json": strings.Split(testPNG, ",")[1]}}})
			return
		}
		if r.URL.Query().Get("key") != "gemini-override" || r.Header.Get("Authorization") != "" {
			t.Error("Gemini auth mismatch")
		}
		var body struct {
			Contents []struct {
				Parts []struct {
					InlineData struct {
						Data string `json:"data"`
					} `json:"inlineData"`
					Text string `json:"text"`
				} `json:"parts"`
			} `json:"contents"`
			Config struct {
				ImageConfig map[string]string `json:"imageConfig"`
			} `json:"generationConfig"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(body.Contents) != 1 || len(body.Contents[0].Parts) != 2 || body.Contents[0].Parts[0].InlineData.Data == "" || body.Config.ImageConfig["aspectRatio"] != "16:9" {
			t.Error("Gemini payload mismatch")
		}
		sendJSON(w, 200, map[string]any{"candidates": []any{map[string]any{"content": map[string]any{"parts": []any{map[string]any{"text": "description"}, map[string]any{"inlineData": map[string]string{"data": strings.Split(testPNG, ",")[1], "mimeType": "image/png"}}}}}}})
	}))
	defer upstream.Close()
	configure(t, s, upstream.URL)
	ref, err := s.persistImage(context.Background(), testPNG)
	if err != nil {
		t.Fatal(err)
	}
	input := GenerationRequest{Provider: "openai", Model: "gpt-image", Prompt: "test", Params: Params{Count: 1, Background: "transparent", AspectRatio: "16:9", ImageSize: "2K"}, ReferenceImages: []ReferenceImage{{ID: "ref", Name: "参考.png", DataURL: ref}}}
	if _, err = s.generate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if err = s.update(func(next *State) error {
		next.Settings.Gemini = ProviderConfig{BaseURL: upstream.URL + "/v1beta", APIKey: "gemini-override"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	input.Provider = "gemini"
	input.Model = "gemini-image"
	if _, err = s.generate(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(paths, []string{"/v1/images/edits", "/v1beta/models/gemini-image:generateContent"}) {
		t.Fatal(paths)
	}
}

func TestHTTPBoundary(t *testing.T) {
	s := newTestStore(t)
	server := httptest.NewServer(newHandler(s, t.TempDir(), true))
	defer server.Close()
	for _, item := range []struct {
		method, path, body, origin, host string
		status                           int
	}{
		{"GET", "/api/state", "", "", "", 200},
		{"GET", "/api/state", "", "https://attacker.test", "", 403},
		{"GET", "/api/state", "", "", "attacker.test", 403},
		{"PUT", "/api/settings", "{broken", "", "", 400},
		{"PUT", "/api/gallery", `{ "tasks":[], "workspaces":[] }`, "", "", 400},
		{"GET", "/api/images/state.json", "", "", "", 404},
		{"GET", "/api/unknown", "", "", "", 404},
	} {
		req, _ := http.NewRequest(item.method, server.URL+item.path, strings.NewReader(item.body))
		if item.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if item.origin != "" {
			req.Header.Set("Origin", item.origin)
		}
		if item.host != "" {
			req.Host = item.host
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != item.status {
			t.Errorf("%s %s = %d, want %d", item.method, item.path, res.StatusCode, item.status)
		}
	}
}

func TestBrowserURL(t *testing.T) {
	for _, item := range []struct{ ip, want string }{
		{"127.0.0.1", "http://127.0.0.1:47831"},
		{"0.0.0.0", "http://127.0.0.1:47831"},
		{"::", "http://127.0.0.1:47831"},
		{"::1", "http://[::1]:47831"},
	} {
		if got := browserURL(&net.TCPAddr{IP: net.ParseIP(item.ip), Port: 47831}); got != item.want {
			t.Errorf("%s: got %s, want %s", item.ip, got, item.want)
		}
	}
}
