package main

type ProviderConfig struct {
	BaseURL string `json:"baseUrl"`
	APIKey  string `json:"apiKey"`
}

type Settings struct {
	Global ProviderConfig `json:"global"`
	OpenAI ProviderConfig `json:"openai"`
	Gemini ProviderConfig `json:"gemini"`
}

type Params struct {
	Size         string `json:"size"`
	Quality      string `json:"quality"`
	Background   string `json:"background"`
	OutputFormat string `json:"outputFormat"`
	AspectRatio  string `json:"aspectRatio"`
	ImageSize    string `json:"imageSize"`
	Count        int    `json:"count"`
}

type ReferenceImage struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	DataURL string `json:"dataUrl"`
}

type Task struct {
	ID              string           `json:"id"`
	Prompt          string           `json:"prompt"`
	Provider        string           `json:"provider"`
	Model           string           `json:"model"`
	Params          Params           `json:"params"`
	ReferenceImages []ReferenceImage `json:"referenceImages,omitempty"`
	Images          []string         `json:"images"`
	Status          string           `json:"status"`
	Error           string           `json:"error,omitempty"`
	CreatedAt       int64            `json:"createdAt"`
	Favorite        bool             `json:"favorite"`
	WorkspaceID     string           `json:"workspaceId,omitempty"`
}

type Workspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
}

type Gallery struct {
	Tasks      []Task      `json:"tasks"`
	Workspaces []Workspace `json:"workspaces"`
}

type State struct {
	Version         int               `json:"version"`
	Initialized     bool              `json:"initialized"`
	GalleryRevision int64             `json:"galleryRevision"`
	Settings        Settings          `json:"settings"`
	ModelSelections map[string]string `json:"modelSelections"`
	LastWorkspace   string            `json:"lastWorkspace"`
	Gallery         Gallery           `json:"gallery"`
	Migrations      []string          `json:"migrations,omitempty"`
}

func defaultState() State {
	return State{
		Version:         1,
		Settings:        Settings{Global: ProviderConfig{BaseURL: "https://code.yansd666.com"}},
		ModelSelections: map[string]string{"openai": "", "gemini": ""},
		Gallery:         Gallery{Tasks: []Task{}, Workspaces: []Workspace{}},
	}
}
