package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func taskRequest(t *testing.T, ctx context.Context, base, method, path string, body any, status int) GallerySnapshot {
	t.Helper()
	data, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != status {
		message, _ := io.ReadAll(res.Body)
		t.Fatalf("%s %s: status %d, want %d: %s", method, path, res.StatusCode, status, message)
	}
	var snapshot GallerySnapshot
	if err := json.NewDecoder(res.Body).Decode(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func taskFixture(id string, count int) Task {
	task := fixtureGallery().Tasks[0]
	task.ID, task.WorkspaceID, task.Favorite = id, "", false
	task.Params.Count = count
	return task
}

func waitTask(t *testing.T, store *Store, check func(Task) bool) Task {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, task := range store.gallerySnapshot().Tasks {
			if check(task) {
				return task
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("task did not reach expected state: %+v", store.gallerySnapshot())
	return Task{}
}

func awaitStarted(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("provider request did not start")
	}
}

func TestBackgroundTaskSurvivesRequestAndPreservesEdits(t *testing.T) {
	var calls atomic.Int32
	started, release, canceled := make(chan struct{}, 4), make(chan struct{}, 4), make(chan struct{}, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		calls.Add(1)
		started <- struct{}{}
		select {
		case <-release:
			sendJSON(w, 200, map[string]any{"data": []any{map[string]string{"b64_json": strings.Split(testPNG, ",")[1]}}})
		case <-r.Context().Done():
			canceled <- struct{}{}
		}
	}))
	defer upstream.Close()
	s := newTestStore(t)
	configure(t, s, upstream.URL)
	handler := newHandler(s, t.TempDir(), true)
	defer handler.Close()
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	task := taskFixture("background", 2)
	snapshot := taskRequest(t, ctx, server.URL, "POST", "/api/tasks", task, 202)
	if len(snapshot.Tasks) != 1 || snapshot.Tasks[0].Status != "running" || len(snapshot.Tasks[0].Images) != 0 || !strings.HasPrefix(snapshot.Tasks[0].ReferenceImages[0].DataURL, imagePrefix) {
		t.Fatalf("task and references were not saved before acceptance: %+v", snapshot)
	}
	cancel() // Equivalent to closing/refreshing the submitting page.
	awaitStarted(t, started)
	ctx = context.Background()
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks", task, 202)
	if calls.Load() != 1 {
		t.Fatal("duplicate submission started another request")
	}
	taskRequest(t, ctx, server.URL, "PATCH", "/api/gallery", map[string]any{
		"taskIds": []string{task.ID}, "favorite": true, "workspaceId": "new-space",
		"workspace": Workspace{ID: "new-space", Name: "生成中归类", CreatedAt: 1},
	}, 200)
	// Even with the newest revision, whole-gallery replacement cannot erase jobs.
	taskRequest(t, ctx, server.URL, "PUT", "/api/gallery", map[string]any{
		"tasks": []Task{}, "workspaces": []Workspace{}, "revision": s.snapshot().GalleryRevision,
	}, 409)
	release <- struct{}{}
	awaitStarted(t, started)
	progress := waitTask(t, s, func(task Task) bool { return task.Status == "running" && len(task.Images) == 1 })
	if !progress.Favorite || progress.WorkspaceID != "new-space" {
		t.Fatal("progress overwrote metadata")
	}
	raw, err := os.ReadFile(filepath.Join(s.dir, "state.json"))
	var saved State
	if err != nil || json.Unmarshal(raw, &saved) != nil || len(saved.Gallery.Tasks[0].Images) != 1 {
		t.Fatal("partial results were not persisted")
	}
	release <- struct{}{}
	done := waitTask(t, s, func(task Task) bool { return task.Status == "done" })
	if len(done.Images) != 2 || !done.Favorite || done.WorkspaceID != "new-space" || calls.Load() != 2 {
		t.Fatalf("unexpected completed task: %+v, calls %d", done, calls.Load())
	}
	select {
	case <-canceled:
		t.Fatal("provider request was canceled with browser request")
	default:
	}
	reopened, err := openStore(s.dir)
	if err != nil || !reflect.DeepEqual(reopened.snapshot(), s.snapshot()) {
		t.Fatal("completion was not saved independently", err)
	}
	for _, image := range done.Images {
		if _, _, err := reopened.imageBytes(ctx, image); err != nil {
			t.Fatal(err)
		}
	}
}

func TestBackgroundRetryAndDelete(t *testing.T) {
	var calls atomic.Int32
	started, release, canceled := make(chan struct{}, 4), make(chan struct{}, 4), make(chan struct{}, 4)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if calls.Add(1) <= 2 {
			sendJSON(w, 502, map[string]any{"error": map[string]string{"message": "模拟生成失败"}})
			return
		}
		started <- struct{}{}
		select {
		case <-release:
			sendJSON(w, 200, map[string]any{"data": []any{map[string]string{"b64_json": strings.Split(testPNG, ",")[1]}}})
		case <-r.Context().Done():
			canceled <- struct{}{}
		}
	}))
	defer upstream.Close()
	s := newTestStore(t)
	configure(t, s, upstream.URL)
	handler := newHandler(s, t.TempDir(), true)
	defer handler.Close()
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx := context.Background()
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks", taskFixture("retry", 1), 202)
	failed := waitTask(t, s, func(task Task) bool { return task.Status == "error" })
	if !strings.Contains(failed.Error, "模拟生成失败") || calls.Load() != 2 {
		t.Fatal("failure/retry policy changed", failed)
	}
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks/retry/retry", nil, 202)
	awaitStarted(t, started)
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks/retry/retry", nil, 202)
	if calls.Load() != 3 {
		t.Fatal("parallel retries started duplicate provider requests")
	}
	release <- struct{}{}
	waitTask(t, s, func(task Task) bool { return task.Status == "done" })
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks/retry/retry", nil, 409)
	taskRequest(t, ctx, server.URL, "POST", "/api/tasks", taskFixture("delete", 1), 202)
	awaitStarted(t, started)
	taskRequest(t, ctx, server.URL, "DELETE", "/api/tasks", map[string]any{"ids": []string{"delete"}}, 200)
	awaitStarted(t, canceled)
	handler.jobs.wg.Wait()
	if tasks := s.gallerySnapshot().Tasks; len(tasks) != 1 || tasks[0].ID != "retry" {
		t.Fatalf("deleted task was resurrected: %+v", tasks)
	}
}

func TestTaskShutdownAndFailedMetadataWrites(t *testing.T) {
	started := make(chan struct{}, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		started <- struct{}{}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	s := newTestStore(t)
	configure(t, s, upstream.URL)
	runner := newTaskRunner(s)
	defer runner.close()
	if err := runner.submit(context.Background(), taskFixture("shutdown", 1), false); err != nil {
		t.Fatal(err)
	}
	awaitStarted(t, started)
	before := s.snapshot()
	path := filepath.Join(s.dir, "state.json")
	if err := os.Rename(path, path+".saved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	favorite := true
	if err := s.editGallery(GalleryEdit{TaskIDs: []string{"shutdown"}, Favorite: &favorite}); err == nil {
		t.Fatal("expected failed edit")
	}
	if err := runner.remove([]string{"shutdown"}); err == nil {
		t.Fatal("expected failed deletion")
	}
	if !reflect.DeepEqual(before, s.snapshot()) {
		t.Fatal("failed write changed committed state")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path+".saved", path); err != nil {
		t.Fatal(err)
	}
	runner.close()
	reopened, err := openStore(s.dir)
	if err != nil {
		t.Fatal(err)
	}
	if task := reopened.gallerySnapshot().Tasks[0]; task.Status != "error" || !strings.Contains(task.Error, "后端已停止") {
		t.Fatal("stopping the backend did not leave a retryable task", task)
	}
}
