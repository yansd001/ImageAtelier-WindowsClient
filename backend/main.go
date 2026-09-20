package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}

func run() error {
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	// Packaged resources and user data always travel with the executable,
	// regardless of Explorer, a shortcut, or the shell's working directory.
	programDir := filepath.Dir(executable)
	address := flag.String("listen", envOr("IMAGE_ATELIER_ADDR", "127.0.0.1:47831"), "HTTP listen address")
	dataDir := flag.String("data", envOr("IMAGE_ATELIER_DATA_DIR", filepath.Join(programDir, "data")), "JSON and image directory")
	webDir := flag.String("web", envOr("IMAGE_ATELIER_WEB_DIR", filepath.Join(programDir, "frontend")), "built frontend directory")
	open := flag.Bool("open-browser", true, "open the page in the default browser on startup")
	apiOnly := flag.Bool("api-only", false, "development: use a separate frontend server")
	parentStdin := flag.Bool("parent-stdin", false, "exit when parent closes stdin")
	flag.Parse()
	if !*apiOnly {
		info, err := os.Stat(filepath.Join(*webDir, "index.html"))
		if err != nil || info.IsDir() {
			return fmt.Errorf("找不到前端页面 %s，请将 frontend 文件夹与 exe 一起放在程序目录中", filepath.Join(*webDir, "index.html"))
		}
	}
	store, err := openStore(*dataDir)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", *address)
	if err != nil {
		return fmt.Errorf("无法监听 %s，请关闭占用此端口的旧程序，或使用 -listen 指定其他端口: %w", *address, err)
	}
	loopback := listener.Addr().(*net.TCPAddr).IP.IsLoopback()
	handler := newHandler(store, *webDir, loopback)
	defer handler.Close()
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *parentStdin {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	}
	stopped := make(chan error, 1)
	go func() { stopped <- server.Serve(listener) }()
	url := browserURL(listener.Addr().(*net.TCPAddr))
	// Development and test launchers read this record to discover the port.
	_ = json.NewEncoder(os.Stdout).Encode(map[string]string{"url": url})
	if !*apiOnly {
		log.Printf("Image Atelier 已启动：%s（关闭此窗口即可停止服务）", url)
		if *open {
			if err := openBrowser(url); err != nil {
				log.Printf("自动打开浏览器失败，请手动访问 %s：%v", url, err)
			}
		}
	}
	select {
	case err = <-stopped:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		if err = server.Shutdown(shutdownCtx); err != nil {
			_ = server.Close()
		}
		return nil
	}
}

func browserURL(address *net.TCPAddr) string {
	host := address.IP.String()
	if address.IP.IsUnspecified() {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, fmt.Sprint(address.Port))
}
