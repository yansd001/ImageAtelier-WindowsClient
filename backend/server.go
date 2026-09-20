package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func sendJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func sendError(w http.ResponseWriter, status int, err error) {
	if errors.Is(err, errConflict) {
		status = http.StatusConflict
	}
	sendJSON(w, status, map[string]string{"error": err.Error()})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, value any, limit int64) bool {
	contentType, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if contentType != "application/json" {
		sendError(w, 415, errors.New("请求需要 application/json"))
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(value); err != nil {
		sendError(w, 400, errors.New("请求 JSON 无效或超过大小限制"))
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		sendError(w, 400, errors.New("请求只能包含一个 JSON 对象"))
		return false
	}
	return true
}

type applicationHandler struct {
	http.Handler
	jobs *taskRunner
}

func (h *applicationHandler) Close() { h.jobs.close() }

func newHandler(store *Store, webDir string, loopbackOnly bool) *applicationHandler {
	jobs := newTaskRunner(store)
	mux := http.NewServeMux()
	// Keep the existing web font while making the browser contact only this server.
	mux.HandleFunc("GET /api/fonts/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !regexp.MustCompile(`^(result\.css|[a-f0-9]{16}\.woff2)$`).MatchString(name) {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://fontsapi.zeoseven.com/442/main/"+name, nil)
		res, err := upstreamClient.Do(req)
		if err != nil {
			http.Error(w, "Font unavailable", 502)
			return
		}
		defer res.Body.Close()
		if res.StatusCode != 200 {
			http.Error(w, "Font unavailable", 502)
			return
		}
		data, err := readLimited(res.Body, 8<<20)
		if err != nil {
			http.Error(w, "Font unavailable", 502)
			return
		}
		w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(data)
	})
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { sendJSON(w, 200, map[string]bool{"ok": true}) })
	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) { sendJSON(w, 200, store.snapshot()) })
	mux.HandleFunc("GET /api/gallery", func(w http.ResponseWriter, r *http.Request) {
		sendJSON(w, 200, store.gallerySnapshot())
	})
	mux.HandleFunc("PATCH /api/gallery", func(w http.ResponseWriter, r *http.Request) {
		var edit GalleryEdit
		if !decodeJSON(w, r, &edit, 1<<20) {
			return
		}
		if err := store.editGallery(edit); err != nil {
			sendError(w, 400, err)
			return
		}
		sendJSON(w, 200, store.gallerySnapshot())
	})
	mux.HandleFunc("POST /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		var task Task
		if !decodeJSON(w, r, &task, 768<<20) {
			return
		}
		if err := jobs.submit(r.Context(), task, false); err != nil {
			sendError(w, 400, err)
			return
		}
		sendJSON(w, http.StatusAccepted, store.gallerySnapshot())
	})
	mux.HandleFunc("POST /api/tasks/{id}/retry", func(w http.ResponseWriter, r *http.Request) {
		if err := jobs.submit(r.Context(), Task{ID: r.PathValue("id")}, true); err != nil {
			sendError(w, 400, err)
			return
		}
		sendJSON(w, http.StatusAccepted, store.gallerySnapshot())
	})
	mux.HandleFunc("DELETE /api/tasks", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			IDs []string `json:"ids"`
		}
		if !decodeJSON(w, r, &input, 1<<20) {
			return
		}
		if err := jobs.remove(input.IDs); err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, store.gallerySnapshot())
	})
	mux.HandleFunc("PUT /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var settings Settings
		if !decodeJSON(w, r, &settings, 1<<20) {
			return
		}
		if err := store.update(func(next *State) error { next.Settings = settings; return nil }); err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, settings)
	})
	mux.HandleFunc("PUT /api/model-selections", func(w http.ResponseWriter, r *http.Request) {
		var selections map[string]string
		if !decodeJSON(w, r, &selections, 1<<20) {
			return
		}
		if selections == nil {
			sendError(w, 400, errors.New("模型选择不能为空"))
			return
		}
		if err := store.update(func(next *State) error {
			next.ModelSelections = map[string]string{"openai": selections["openai"], "gemini": selections["gemini"]}
			return nil
		}); err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, selections)
	})
	mux.HandleFunc("PUT /api/last-workspace", func(w http.ResponseWriter, r *http.Request) {
		var value struct {
			ID string `json:"id"`
		}
		if !decodeJSON(w, r, &value, 1<<20) {
			return
		}
		if err := store.update(func(next *State) error { next.LastWorkspace = value.ID; return nil }); err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, value)
	})
	mux.HandleFunc("PUT /api/gallery", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Gallery
			Revision *int64 `json:"revision"`
		}
		if !decodeJSON(w, r, &input, 2<<30) {
			return
		}
		if input.Revision == nil {
			sendError(w, 400, errors.New("缺少画廊版本"))
			return
		}
		gallery, revision, err := store.saveGallery(r.Context(), input.Gallery, *input.Revision)
		if err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, struct {
			Gallery
			Revision int64 `json:"revision"`
		}{gallery, revision})
	})
	mux.HandleFunc("POST /api/migrate", func(w http.ResponseWriter, r *http.Request) {
		input := defaultState()
		if !decodeJSON(w, r, &input, 2<<30) {
			return
		}
		if err := store.migrate(r.Context(), input); err != nil {
			sendError(w, 500, err)
			return
		}
		sendJSON(w, 200, store.snapshot())
	})
	mux.HandleFunc("GET /api/models", func(w http.ResponseWriter, r *http.Request) {
		models, err := availableModels(r.Context(), store.snapshot().Settings, r.URL.Query().Get("provider"))
		if err != nil {
			sendError(w, 502, err)
			return
		}
		sendJSON(w, 200, models)
	})
	mux.HandleFunc("POST /api/images/import", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Source string `json:"source"`
		}
		if !decodeJSON(w, r, &input, 96<<20) {
			return
		}
		image, err := store.persistImage(r.Context(), input.Source)
		if err != nil {
			sendError(w, 502, err)
			return
		}
		sendJSON(w, 200, map[string]string{"url": image})
	})
	mux.HandleFunc("GET /api/images/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !imageName.MatchString(name) {
			sendError(w, 404, errors.New("图片路径无效"))
			return
		}
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(store.dir, "images", name))
	})
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) { sendError(w, 404, errors.New("接口不存在")) })
	files := http.FileServer(http.Dir(webDir))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		// Never expose the data directory or project source through the static server.
		if r.URL.Path == "/" {
			if _, err := os.Stat(filepath.Join(webDir, "index.html")); err != nil {
				http.Error(w, "前端资源文件缺失，请恢复程序目录下的 frontend 文件夹。", 503)
				return
			}
		}
		files.ServeHTTP(w, r)
	})
	return &applicationHandler{http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		host := r.Host
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		ip := net.ParseIP(host)
		if loopbackOnly && host != "localhost" && (ip == nil || !ip.IsLoopback()) {
			sendError(w, 403, errors.New("仅允许本机访问"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					sendError(w, 403, errors.New("不允许跨站请求"))
					return
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				sendError(w, 403, errors.New("不允许跨站请求"))
				return
			}
		}
		mux.ServeHTTP(w, r)
	}), jobs}
}
