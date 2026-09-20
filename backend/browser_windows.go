package main

import (
	"os/exec"
	"syscall"
)

func openBrowser(url string) error {
	command := exec.Command("rundll32.exe", "url.dll,FileProtocolHandler", url)
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := command.Start(); err != nil {
		return err
	}
	go func() { _ = command.Wait() }()
	return nil
}
