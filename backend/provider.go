package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
)

func validProvider(provider string) bool { return provider == "openai" || provider == "gemini" }

func providerConfig(settings Settings, provider string) (string, string, error) {
	if !validProvider(provider) {
		return "", "", errors.New("不支持的提供商")
	}
	config := settings.OpenAI
	if provider == "gemini" {
		config = settings.Gemini
	}
	key := strings.TrimSpace(config.APIKey)
	if key == "" {
		key = strings.TrimSpace(settings.Global.APIKey)
	}
	root := strings.TrimSpace(config.BaseURL)
	if root == "" {
		root = strings.TrimSpace(settings.Global.BaseURL)
	}
	root = strings.TrimRight(root, "/")
	for _, suffix := range []string{"/v1beta", "/v1"} {
		if strings.HasSuffix(strings.ToLower(root), suffix) {
			root = root[:len(root)-len(suffix)]
			break
		}
	}
	if root == "" {
		root = "https://code.yansd666.com"
	}
	u, err := httpURL(root)
	if err != nil {
		return "", "", err
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", "", errors.New("Base URL 不能包含查询参数或片段")
	}
	return root, key, nil
}

func upstreamJSON(ctx context.Context, target, key, contentType string, body io.Reader, result any) error {
	method := http.MethodPost
	if body == nil {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return errors.New("请求地址无效")
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := upstreamClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		// Do not include the URL: Gemini's API key is in its query string.
		return errors.New("后端请求提供商失败，请检查网络和 Base URL（单次请求超时为 5 分钟）")
	}
	defer res.Body.Close()
	data, err := readLimited(res.Body, 96<<20)
	if err != nil {
		return err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		var failure struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Error.Message != "" {
			return errors.New(failure.Error.Message)
		}
		return fmt.Errorf("提供商请求失败 (%d)", res.StatusCode)
	}
	if err = json.Unmarshal(data, result); err != nil {
		return errors.New("提供商返回了无效的 JSON 响应")
	}
	return nil
}

func availableModels(ctx context.Context, settings Settings, provider string) ([]string, error) {
	root, key, err := providerConfig(settings, provider)
	if err != nil {
		return nil, err
	}
	models := []string{}
	if key == "" {
		return models, nil
	}
	var response struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err = upstreamJSON(ctx, root+"/v1/models", key, "", nil, &response); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	keyword := "gpt"
	if provider == "gemini" {
		keyword = "gemini"
	}
	for _, item := range response.Data {
		id := item.ID
		if id == "" {
			id = item.Name
		}
		lower := strings.ToLower(id)
		if !seen[id] && strings.Contains(lower, "image") && strings.Contains(lower, keyword) {
			models = append(models, id)
			seen[id] = true
		}
	}
	return models, nil
}

type GenerationRequest struct {
	Provider        string           `json:"provider"`
	Model           string           `json:"model"`
	Prompt          string           `json:"prompt"`
	Params          Params           `json:"params"`
	ReferenceImages []ReferenceImage `json:"referenceImages"`
}

type referenceData struct {
	Name, MIME, Base64 string
	Bytes              []byte
}

func (s *Store) generate(ctx context.Context, input GenerationRequest) ([]string, error) {
	root, key, err := providerConfig(s.snapshot().Settings, input.Provider)
	if err != nil {
		return nil, err
	}
	if key == "" {
		return nil, errors.New("请先在设置中配置全局或提供商 API Key")
	}
	if strings.TrimSpace(input.Model) == "" {
		return nil, errors.New("请输入生图模型")
	}
	if strings.TrimSpace(input.Prompt) == "" {
		return nil, errors.New("请先输入提示词")
	}
	if len(input.ReferenceImages) > 8 {
		return nil, errors.New("最多上传 8 张参考图")
	}
	refs := []referenceData{}
	for _, image := range input.ReferenceImages {
		data, mime, err := s.imageBytes(ctx, image.DataURL)
		if err != nil {
			return nil, err
		}
		refs = append(refs, referenceData{image.Name, mime, base64.StdEncoding.EncodeToString(data), data})
	}
	count := max(1, min(4, input.Params.Count))
	images := []string{}
	var lastError error
	for i := 0; i < count; i++ {
		for attempt := 0; attempt < 2; attempt++ {
			if ctx.Err() != nil {
				return images, ctx.Err()
			}
			var image string
			image, lastError = s.generateSingle(ctx, root, key, input, refs)
			if lastError == nil {
				images = append(images, image)
				break
			}
		}
	}
	if len(images) == 0 {
		return nil, fmt.Errorf("图片生成失败（已自动重试一次）：%w", lastError)
	}
	return images, nil
}

func (s *Store) generateSingle(ctx context.Context, root, key string, input GenerationRequest, refs []referenceData) (string, error) {
	p := input.Params
	if input.Provider == "openai" {
		fields := map[string]any{"model": input.Model, "prompt": input.Prompt, "size": p.Size, "quality": p.Quality, "background": p.Background, "output_format": p.OutputFormat, "n": 1}
		contentType := "application/json"
		data, _ := json.Marshal(fields)
		body := bytes.NewBuffer(data)
		target := root + "/v1/images/generations"
		if len(refs) > 0 {
			body = &bytes.Buffer{}
			writer := multipart.NewWriter(body)
			for name, value := range fields {
				if err := writer.WriteField(name, fmt.Sprint(value)); err != nil {
					return "", err
				}
			}
			for _, ref := range refs {
				// Escape names to keep each upload in a single multipart header.
				name := strings.NewReplacer("\\", "_", "\"", "_", "\r", "_", "\n", "_").Replace(ref.Name)
				header := textproto.MIMEHeader{}
				header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="image[]"; filename="%s"`, name))
				header.Set("Content-Type", ref.MIME)
				part, err := writer.CreatePart(header)
				if err != nil {
					return "", err
				}
				if _, err = part.Write(ref.Bytes); err != nil {
					return "", err
				}
			}
			if err := writer.Close(); err != nil {
				return "", err
			}
			contentType = writer.FormDataContentType()
			target = root + "/v1/images/edits"
		}
		var response struct {
			Data []struct {
				Base64 string `json:"b64_json"`
				URL    string `json:"url"`
			} `json:"data"`
		}
		if err := upstreamJSON(ctx, target, key, contentType, body, &response); err != nil {
			return "", err
		}
		for _, item := range response.Data {
			if item.Base64 != "" {
				value := item.Base64
				if !strings.HasPrefix(value, "data:") {
					value = "data:image/png;base64," + value
				}
				return s.persistImage(ctx, value)
			}
			if item.URL != "" {
				return s.persistImage(ctx, item.URL)
			}
		}
		return "", errors.New("OpenAI 未返回图片数据")
	}
	parts := []any{}
	for _, ref := range refs {
		parts = append(parts, map[string]any{"inlineData": map[string]string{"mimeType": ref.MIME, "data": ref.Base64}})
	}
	parts = append(parts, map[string]string{"text": input.Prompt})
	body, _ := json.Marshal(map[string]any{
		"contents":         []any{map[string]any{"parts": parts}},
		"generationConfig": map[string]any{"responseModalities": []string{"TEXT", "IMAGE"}, "imageConfig": map[string]string{"aspectRatio": p.AspectRatio, "imageSize": p.ImageSize}},
	})
	var response struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					InlineData *struct {
						Data string `json:"data"`
						MIME string `json:"mimeType"`
					} `json:"inlineData"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	target := root + "/v1beta/models/" + url.PathEscape(input.Model) + ":generateContent?key=" + url.QueryEscape(key)
	if err := upstreamJSON(ctx, target, "", "application/json", bytes.NewReader(body), &response); err != nil {
		return "", err
	}
	for _, candidate := range response.Candidates {
		for _, part := range candidate.Content.Parts {
			if part.InlineData != nil && part.InlineData.Data != "" {
				value := part.InlineData.Data
				if !strings.HasPrefix(value, "data:") {
					value = "data:" + part.InlineData.MIME + ";base64," + value
				}
				return s.persistImage(ctx, value)
			}
		}
	}
	return "", errors.New("Gemini 未返回图片数据，请确认模型支持图像输出")
}
