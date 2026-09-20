package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"time"
)

var errConflict = errors.New("画廊已在其他窗口更新，请刷新页面后再操作")

type Store struct {
	mu    sync.Mutex
	dir   string
	state State
}

func openStore(dir string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0700); err != nil {
		return nil, err
	}
	s := &Store{dir: dir, state: defaultState()}
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		if err = json.Unmarshal(data, &s.state); err != nil {
			return nil, fmt.Errorf("state.json 损坏，原文件未修改: %w", err)
		}
		if s.state.Version != 1 {
			return nil, errors.New("不支持的 state.json 版本，原文件未修改")
		}
		if err = validateGallery(s.state.Gallery); err != nil {
			return nil, fmt.Errorf("state.json 无效: %w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	// Only restarting the backend interrupts jobs. Browser navigation does not.
	changed := false
	for i := range s.state.Gallery.Tasks {
		if s.state.Gallery.Tasks[i].Status == "running" {
			s.state.Gallery.Tasks[i].Status = "error"
			s.state.Gallery.Tasks[i].Error = "上次生成已中断，可以重试"
			changed = true
		}
	}
	if changed {
		s.state.GalleryRevision++
		if err = s.commit(s.state); err != nil {
			return nil, err
		}
	}
	s.cleanUnusedImages()
	return s, nil
}

// Write next to the destination so the rename stays on the same filesystem.
// Immutable image files are committed before metadata. Failed writes never
// truncate the last usable state.json or overwrite an existing image.
func atomicWrite(path string, data []byte) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".pending-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *Store) commit(next State) error {
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	if err = atomicWrite(filepath.Join(s.dir, "state.json"), data); err != nil {
		return err
	}
	s.state = next
	return nil
}

func (s *Store) snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Callers never receive references into mutable store state.
	data, _ := json.Marshal(s.state)
	var state State
	_ = json.Unmarshal(data, &state)
	return state
}

func (s *Store) update(change func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.state
	if err := change(&next); err != nil {
		return err
	}
	next.Initialized = true
	return s.commit(next)
}

func validateGallery(g Gallery) error {
	if g.Tasks == nil || g.Workspaces == nil {
		return errors.New("画廊需要 tasks 和 workspaces 数组")
	}
	ids := map[string]bool{}
	for _, w := range g.Workspaces {
		if w.ID == "" || strings.TrimSpace(w.Name) == "" || ids[w.ID] {
			return errors.New("工作区数据无效或 ID 重复")
		}
		ids[w.ID] = true
	}
	taskIDs := map[string]bool{}
	for _, t := range g.Tasks {
		if t.ID == "" || taskIDs[t.ID] || !validProvider(t.Provider) || (t.Status != "running" && t.Status != "done" && t.Status != "error") || t.Images == nil || len(t.ReferenceImages) > 8 {
			return errors.New("作品数据无效或 ID 重复")
		}
		if t.WorkspaceID != "" && !ids[t.WorkspaceID] {
			return errors.New("作品的工作区不存在")
		}
		taskIDs[t.ID] = true
	}
	return nil
}

func (s *Store) prepareGallery(ctx context.Context, g Gallery) (Gallery, error) {
	if err := validateGallery(g); err != nil {
		return g, err
	}
	g.Tasks = append([]Task{}, g.Tasks...)
	g.Workspaces = append([]Workspace{}, g.Workspaces...)
	for i := range g.Tasks {
		t := &g.Tasks[i]
		t.Images = append([]string{}, t.Images...)
		t.ReferenceImages = append([]ReferenceImage(nil), t.ReferenceImages...)
		for j, value := range t.Images {
			image, err := s.persistImage(ctx, value)
			if err != nil {
				return g, err
			}
			t.Images[j] = image
		}
		for j := range t.ReferenceImages {
			image, err := s.persistImage(ctx, t.ReferenceImages[j].DataURL)
			if err != nil {
				return g, err
			}
			t.ReferenceImages[j].DataURL = image
		}
	}
	return g, nil
}

func (s *Store) saveGallery(ctx context.Context, g Gallery, revision int64) (Gallery, int64, error) {
	prepared, err := s.prepareGallery(ctx, g)
	if err != nil {
		return g, revision, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// Loading a second window or releasing inline image strings must not
	// invalidate the first window's revision without an actual gallery edit.
	if reflect.DeepEqual(s.state.Gallery, prepared) {
		return prepared, s.state.GalleryRevision, nil
	}
	if s.state.GalleryRevision != revision {
		return prepared, revision, errConflict
	}
	for _, task := range s.state.Gallery.Tasks {
		if task.Status == "running" {
			return prepared, revision, fmt.Errorf("%w：请等待生成完成后再导入画廊", errConflict)
		}
	}
	next := s.state
	next.Gallery = prepared
	next.GalleryRevision++
	next.Initialized = true
	err = s.commit(next)
	return prepared, next.GalleryRevision, err
}

func (s *Store) migrate(ctx context.Context, incoming State) error {
	data, _ := json.Marshal(incoming)
	hash := sha256.Sum256(data)
	id := hex.EncodeToString(hash[:])
	for _, done := range s.snapshot().Migrations {
		if done == id {
			return nil
		}
	}
	g, err := s.prepareGallery(ctx, incoming.Gallery)
	if err != nil {
		return err
	}
	return s.update(func(next *State) error {
		for _, done := range next.Migrations {
			if done == id {
				return nil
			}
		}
		merged := Gallery{Tasks: append([]Task{}, next.Gallery.Tasks...), Workspaces: append([]Workspace{}, next.Gallery.Workspaces...)}
		workspaceIDs := map[string]string{}
		for _, w := range g.Workspaces {
			found := false
			for _, existing := range merged.Workspaces {
				if existing.Name == w.Name {
					workspaceIDs[w.ID] = existing.ID
					found = true
					break
				}
			}
			if found {
				continue
			}
			oldID := w.ID
			for _, existing := range merged.Workspaces {
				if existing.ID == w.ID {
					w.ID = "migrated-" + id + "-" + w.ID
					break
				}
			}
			workspaceIDs[oldID] = w.ID
			merged.Workspaces = append(merged.Workspaces, w)
		}
		existingIDs := map[string]bool{}
		for _, t := range merged.Tasks {
			existingIDs[t.ID] = true
		}
		for _, t := range g.Tasks {
			if existingIDs[t.ID] {
				continue
			}
			t.WorkspaceID = workspaceIDs[t.WorkspaceID]
			if t.Status == "running" {
				t.Status = "error"
				t.Error = "上次生成已中断，可以重试"
			}
			merged.Tasks = append(merged.Tasks, t)
		}
		sort.SliceStable(merged.Tasks, func(i, j int) bool { return merged.Tasks[i].CreatedAt > merged.Tasks[j].CreatedAt })
		if !next.Initialized {
			next.Settings = incoming.Settings
			if incoming.ModelSelections != nil {
				next.ModelSelections = incoming.ModelSelections
			}
			next.LastWorkspace = workspaceIDs[incoming.LastWorkspace]
		}
		next.Gallery = merged
		next.GalleryRevision++
		next.Migrations = append(append([]string{}, next.Migrations...), id)
		return nil
	})
}

// Run only at startup, when this process has no active jobs. Keep recent files
// in case a previous process stopped between writing an image and its metadata.
func (s *Store) cleanUnusedImages() {
	used := map[string]bool{}
	for _, t := range s.state.Gallery.Tasks {
		for _, image := range t.Images {
			used[strings.TrimPrefix(image, imagePrefix)] = true
		}
		for _, image := range t.ReferenceImages {
			used[strings.TrimPrefix(image.DataURL, imagePrefix)] = true
		}
	}
	entries, _ := os.ReadDir(filepath.Join(s.dir, "images"))
	for _, entry := range entries {
		if entry.IsDir() || used[entry.Name()] {
			continue
		}
		info, err := entry.Info()
		if err == nil && time.Since(info.ModTime()) > 24*time.Hour {
			_ = os.Remove(filepath.Join(s.dir, "images", entry.Name()))
		}
	}
}
