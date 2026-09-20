package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

type GallerySnapshot struct {
	Gallery
	Revision int64 `json:"revision"`
}

func (s *Store) gallerySnapshot() GallerySnapshot {
	state := s.snapshot()
	return GallerySnapshot{state.Gallery, state.GalleryRevision}
}

// Edits contain only user-managed fields, never generation status or results.
type GalleryEdit struct {
	TaskIDs     []string   `json:"taskIds"`
	Favorite    *bool      `json:"favorite"`
	WorkspaceID *string    `json:"workspaceId"`
	Workspace   *Workspace `json:"workspace"`
}

func (s *Store) editGallery(edit GalleryEdit) error {
	return s.update(func(next *State) error {
		g := &next.Gallery
		g.Tasks = append([]Task{}, g.Tasks...)
		g.Workspaces = append([]Workspace{}, g.Workspaces...)
		if edit.Workspace != nil {
			g.Workspaces = append(g.Workspaces, *edit.Workspace)
		}
		ids := make(map[string]bool, len(edit.TaskIDs))
		for _, id := range edit.TaskIDs {
			ids[id] = true
		}
		for i := range g.Tasks {
			if !ids[g.Tasks[i].ID] {
				continue
			}
			if edit.Favorite != nil {
				g.Tasks[i].Favorite = *edit.Favorite
			}
			if edit.WorkspaceID != nil {
				g.Tasks[i].WorkspaceID = *edit.WorkspaceID
			}
		}
		if err := validateGallery(*g); err != nil {
			return err
		}
		next.GalleryRevision++
		return nil
	})
}

type generationJob struct {
	cancel context.CancelFunc
}

// Jobs belong to the application, not to the HTTP request or browser window.
// The mutex serializes job admission, deletion and result publication; store
// updates always operate on the latest gallery and preserve concurrent edits.
type taskRunner struct {
	mu     sync.Mutex
	store  *Store
	ctx    context.Context
	cancel context.CancelFunc
	active map[string]*generationJob
	wg     sync.WaitGroup
}

func newTaskRunner(store *Store) *taskRunner {
	ctx, cancel := context.WithCancel(context.Background())
	return &taskRunner{store: store, ctx: ctx, cancel: cancel, active: map[string]*generationJob{}}
}

func (r *taskRunner) close() {
	r.mu.Lock()
	r.cancel()
	r.mu.Unlock()
	r.wg.Wait()
}

func (r *taskRunner) submit(ctx context.Context, task Task, retry bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.ctx.Err() != nil {
		return errors.New("后端正在停止，请稍后重试")
	}
	state := r.store.snapshot()
	found := false
	for _, existing := range state.Gallery.Tasks {
		if existing.ID != task.ID {
			continue
		}
		// A repeated submission must never issue a second paid request.
		if !retry || r.active[task.ID] != nil {
			return nil
		}
		if existing.Status != "error" {
			return fmt.Errorf("%w：只能重试失败的任务", errConflict)
		}
		task = existing
		found = true
		break
	}
	if retry && !found {
		return errors.New("任务不存在")
	}
	if r.active[task.ID] != nil {
		return errConflict
	}
	if task.ID == "" || len(task.ID) > 200 || strings.ContainsAny(task.ID, "/\\") {
		return errors.New("任务 ID 无效")
	}
	if strings.TrimSpace(task.Prompt) == "" || strings.TrimSpace(task.Model) == "" {
		return errors.New("请输入提示词和生图模型")
	}
	_, key, err := providerConfig(state.Settings, task.Provider)
	if err != nil {
		return err
	}
	if key == "" {
		return errors.New("请先在设置中配置全局或提供商 API Key")
	}
	task.Status, task.Error, task.Images = "running", "", []string{}
	task.Params.Count = max(1, min(4, task.Params.Count))
	if task.CreatedAt <= 0 {
		task.CreatedAt = time.Now().UnixMilli()
	}
	// Persist references and metadata before acknowledging task acceptance.
	prepared, err := r.store.prepareGallery(ctx, Gallery{[]Task{task}, state.Gallery.Workspaces})
	if err != nil {
		return err
	}
	task = prepared.Tasks[0]
	err = r.store.update(func(next *State) error {
		next.Gallery.Tasks = append([]Task{}, next.Gallery.Tasks...)
		if retry {
			replaced := false
			for i := range next.Gallery.Tasks {
				if next.Gallery.Tasks[i].ID == task.ID {
					if next.Gallery.Tasks[i].Status != "error" {
						return errConflict
					}
					// Metadata may have changed while references were being saved.
					task.Favorite = next.Gallery.Tasks[i].Favorite
					task.WorkspaceID = next.Gallery.Tasks[i].WorkspaceID
					next.Gallery.Tasks[i] = task
					replaced = true
				}
			}
			if !replaced {
				return errors.New("任务不存在")
			}
		} else {
			for _, existing := range next.Gallery.Tasks {
				if existing.ID == task.ID {
					return errConflict
				}
			}
			next.Gallery.Tasks = append([]Task{task}, next.Gallery.Tasks...)
		}
		if err := validateGallery(next.Gallery); err != nil {
			return err
		}
		next.GalleryRevision++
		return nil
	})
	if err != nil {
		return err
	}
	jobCtx, cancel := context.WithCancel(r.ctx)
	job := &generationJob{cancel: cancel}
	r.active[task.ID] = job
	r.wg.Add(1)
	go r.run(jobCtx, job, task, state.Settings)
	return nil
}

func (r *taskRunner) run(ctx context.Context, job *generationJob, task Task, settings Settings) {
	defer r.wg.Done()
	defer job.cancel()
	input := GenerationRequest{task.Provider, task.Model, task.Prompt, task.Params, task.ReferenceImages}
	images, err := r.store.generateWithProgress(ctx, settings, input, func(images []string) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		if r.active[task.ID] != job {
			return context.Canceled
		}
		return r.saveResult(task.ID, images, "running", "")
	})
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[task.ID] != job {
		return // Deleted tasks cannot be recreated by late provider responses.
	}
	defer delete(r.active, task.ID)
	status, message := "done", ""
	if err != nil {
		status, message = "error", err.Error()
		if ctx.Err() != nil {
			message = "后端已停止，生成已中断，可以重试"
		}
	}
	if err := r.saveResult(task.ID, images, status, message); err != nil {
		log.Printf("保存生成任务 %s 失败：%v", task.ID, err)
	}
}

func (r *taskRunner) saveResult(id string, images []string, status, message string) error {
	return r.store.update(func(next *State) error {
		next.Gallery.Tasks = append([]Task{}, next.Gallery.Tasks...)
		for i := range next.Gallery.Tasks {
			task := &next.Gallery.Tasks[i]
			if task.ID == id {
				task.Images = append([]string{}, images...)
				task.Status, task.Error = status, message
				next.GalleryRevision++
				return nil
			}
		}
		return context.Canceled
	})
}

func (r *taskRunner) remove(ids []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	removed := make(map[string]bool, len(ids))
	for _, id := range ids {
		removed[id] = true
	}
	if err := r.store.update(func(next *State) error {
		tasks := []Task{}
		for _, task := range next.Gallery.Tasks {
			if !removed[task.ID] {
				tasks = append(tasks, task)
			}
		}
		next.Gallery.Tasks = tasks
		next.GalleryRevision++
		return nil
	}); err != nil {
		return err
	}
	for id := range removed {
		if job := r.active[id]; job != nil {
			delete(r.active, id)
			job.cancel()
		}
	}
	return nil
}
