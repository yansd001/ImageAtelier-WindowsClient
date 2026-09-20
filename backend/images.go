package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const imagePrefix = "/api/images/"
const maxImageBytes = 64 << 20

var imageName = regexp.MustCompile(`^[a-f0-9]{64}\.(png|jpg|webp|gif|avif)$`)
var upstreamClient = &http.Client{Timeout: 5 * time.Minute}

func imageType(data []byte) (string, string, error) {
	if len(data) >= 12 {
		switch {
		case string(data[:4]) == "\x89PNG":
			return "image/png", "png", nil
		case data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
			return "image/jpeg", "jpg", nil
		case string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
			return "image/webp", "webp", nil
		case string(data[:4]) == "GIF8":
			return "image/gif", "gif", nil
		case string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis"):
			return "image/avif", "avif", nil
		}
	}
	return "", "", errors.New("图片格式无效，支持 PNG、JPEG、WEBP、GIF 和 AVIF")
}

func readLimited(r io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, limit+1))
	if err == nil && int64(len(data)) > limit {
		err = errors.New("响应内容过大")
	}
	return data, err
}

func httpURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return nil, errors.New("地址必须是有效的 HTTP 或 HTTPS URL")
	}
	return u, nil
}

func (s *Store) imageBytes(ctx context.Context, value string) ([]byte, string, error) {
	var data []byte
	var err error
	switch {
	case strings.HasPrefix(value, imagePrefix):
		name := strings.TrimPrefix(value, imagePrefix)
		if !imageName.MatchString(name) {
			return nil, "", errors.New("图片路径无效")
		}
		data, err = os.ReadFile(filepath.Join(s.dir, "images", name))
		if errors.Is(err, os.ErrNotExist) {
			return nil, "", errors.New("本地图片数据缺失，无法读取或导出该作品")
		}
	case strings.HasPrefix(value, "data:"):
		header, content, ok := strings.Cut(value, ",")
		if !ok || !strings.HasSuffix(header, ";base64") {
			return nil, "", errors.New("图片必须为 base64 data URL")
		}
		if base64.StdEncoding.DecodedLen(len(content)) > maxImageBytes {
			return nil, "", errors.New("单张图片不能超过 64 MB")
		}
		data, err = base64.StdEncoding.DecodeString(content)
	default:
		if _, err = httpURL(value); err != nil {
			return nil, "", err
		}
		req, reqErr := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
		if reqErr != nil {
			return nil, "", errors.New("图片地址无效")
		}
		res, reqErr := upstreamClient.Do(req)
		if reqErr != nil {
			return nil, "", errors.New("后端下载远程图片失败，请检查网络或图片地址")
		}
		defer res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, "", fmt.Errorf("远程图片读取失败 (%d)", res.StatusCode)
		}
		data, err = readLimited(res.Body, maxImageBytes)
	}
	if err != nil {
		return nil, "", err
	}
	mime, _, err := imageType(data)
	return data, mime, err
}

func (s *Store) persistImage(ctx context.Context, value string) (string, error) {
	// Existing assets are immutable; do not re-read large originals for every
	// favorite/workspace change. Still reject missing or unsafe references.
	if strings.HasPrefix(value, imagePrefix) {
		name := strings.TrimPrefix(value, imagePrefix)
		if !imageName.MatchString(name) {
			return "", errors.New("图片路径无效")
		}
		if _, err := os.Stat(filepath.Join(s.dir, "images", name)); err != nil {
			return "", errors.New("本地图片数据缺失")
		}
		return value, nil
	}
	data, _, err := s.imageBytes(ctx, value)
	if err != nil {
		return "", err
	}
	_, ext, _ := imageType(data)
	hash := sha256.Sum256(data)
	name := hex.EncodeToString(hash[:]) + "." + ext
	path := filepath.Join(s.dir, "images", name)
	if _, err = os.Stat(path); errors.Is(err, os.ErrNotExist) {
		err = atomicWrite(path, data)
	}
	if err != nil {
		return "", err
	}
	return imagePrefix + name, nil
}
