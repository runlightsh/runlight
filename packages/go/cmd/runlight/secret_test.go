package main

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Servers starting at once on one folder agree on the secret, and it is readable only by its owner.
func TestServersStartingAtOnceAgreeOnTheSecret(t *testing.T) {
	dir := t.TempDir()
	var wg sync.WaitGroup
	secrets := make(chan string, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			secret, err := secretIn(dir)
			if err != nil {
				t.Error(err)
			}
			secrets <- secret
		}()
	}
	wg.Wait()
	close(secrets)
	saved, err := os.ReadFile(filepath.Join(dir, "secret"))
	if err != nil {
		t.Fatal(err)
	}
	kept := strings.TrimSpace(string(saved))
	if len(kept) != 64 {
		t.Fatalf("kept %q", kept)
	}
	for secret := range secrets {
		if secret != kept {
			t.Errorf("%q is not the secret kept, %q", secret, kept)
		}
	}
	if info, _ := os.Stat(filepath.Join(dir, "secret")); info.Mode().Perm() != 0o600 {
		t.Errorf("mode %v", info.Mode().Perm())
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("%d files left, want only the secret", len(entries))
	}
}

// A file too short to be whole is waited for and then refused, never used; a whole one written by hand is kept.
func TestAShortSecretIsRefusedAndAWholeOneKept(t *testing.T) {
	was := secretWait
	secretWait = 300 * time.Millisecond
	defer func() { secretWait = was }()
	for _, content := range []string{"", "\n", "short\n"} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "secret"), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		secret, err := secretIn(dir)
		if err == nil || secret != "" || !strings.Contains(err.Error(), "holds no whole secret") {
			t.Errorf("%q: %q, %v", content, secret, err)
		}
	}
	dir := t.TempDir()
	mine := strings.Repeat("ab", 20)
	if err := os.WriteFile(filepath.Join(dir, "secret"), []byte(mine+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if secret, err := secretIn(dir); err != nil || secret != mine {
		t.Errorf("%q, %v", secret, err)
	}
}
