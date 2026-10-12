package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// shortest is shorter than any secret this file has ever been given, so a file caught half written is never used.
const shortest = 32

// secretWait is how long a file too short to be whole is read again before it is refused.
var secretWait = 2 * time.Second

// secretIn is the secret kept in dataDir, made on first run, readable only by this user. Two servers starting
// at once on one folder agree on it: the new secret is written whole to a file of its own, then linked into
// place, which refuses to replace a file already there, and the one that loses reads the winner's. A file read
// empty or short, such as one an older version was still writing, is read again for a moment, and then
// refused, never used.
func secretIn(dataDir string) (string, error) {
	file := filepath.Join(dataDir, "secret")
	found, ok, err := readWhole(file)
	if err != nil || ok {
		return found, err
	}
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	made := hex.EncodeToString(b)
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	temp := filepath.Join(dataDir, fmt.Sprintf(".secret-%d-%s", os.Getpid(), hex.EncodeToString(suffix)))
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", err
	}
	defer os.Remove(temp)
	_, err = f.WriteString(made + "\n")
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err := os.Chmod(temp, 0o600); err != nil {
		return "", err
	}
	err = os.Link(temp, file)
	if err == nil {
		return made, nil
	}
	if errors.Is(err, fs.ErrExist) {
		return winner(file)
	}
	// A file system with no hard links still creates the file only if it is not there; a reader that
	// catches it before its contents land reads it again.
	g, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return winner(file)
		}
		return "", err
	}
	_, err = g.WriteString(made + "\n")
	if closeErr := g.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	return made, os.Chmod(file, 0o600)
}

// winner is the secret another server linked into place first.
func winner(file string) (string, error) {
	found, ok, err := readWhole(file)
	if err != nil || ok {
		return found, err
	}
	return "", refuse(file)
}

// readWhole is the secret in a file, waiting a moment for one too short to be whole; false when there is no file.
func readWhole(file string) (string, bool, error) {
	deadline := time.Now().Add(secretWait)
	for {
		saved, err := os.ReadFile(file)
		if errors.Is(err, fs.ErrNotExist) {
			return "", false, nil
		}
		if err != nil {
			return "", false, err
		}
		if text := strings.TrimSpace(string(saved)); len(text) >= shortest {
			return text, true, nil
		}
		if !time.Now().Before(deadline) {
			return "", false, refuse(file)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

func refuse(file string) error {
	return fmt.Errorf("%s holds no whole secret. Delete it to have a new one made, which signs everyone out, or set RUNLIGHT_SECRET.", file)
}
