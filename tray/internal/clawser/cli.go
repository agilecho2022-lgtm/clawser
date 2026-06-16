package clawser

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type CLI struct {
	command string
	prefix  []string
	dir     string
}

var devCheckoutRoot string

func ResolveCLI() CLI {
	if envPath := strings.TrimSpace(os.Getenv("CLAWSER_BIN")); envPath != "" {
		return commandForPath(envPath, "")
	}

	if devCheckoutRoot != "" && isCheckoutRoot(devCheckoutRoot) {
		return commandForPath(filepath.Join(devCheckoutRoot, "clawser.mjs"), devCheckoutRoot)
	}

	if root, ok := findCheckoutRoot(); ok {
		return commandForPath(filepath.Join(root, "clawser.mjs"), root)
	}

	if path, err := exec.LookPath("clawser"); err == nil {
		return CLI{command: path}
	}

	return CLI{command: "clawser"}
}

func (c CLI) Run(ctx context.Context, args ...string) (string, error) {
	if c.command == "" {
		return "", errors.New("clawser command is not configured")
	}
	cmdArgs := append([]string{}, c.prefix...)
	cmdArgs = append(cmdArgs, args...)
	cmd := exec.CommandContext(ctx, c.command, cmdArgs...)
	if c.dir != "" {
		cmd.Dir = c.dir
	}
	cmd.Env = os.Environ()
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	return out.String(), err
}

func commandForPath(path string, dir string) CLI {
	if strings.HasSuffix(path, ".mjs") || strings.HasSuffix(path, ".js") {
		return CLI{command: resolveNode(), prefix: []string{path}, dir: dir}
	}
	return CLI{command: path, dir: dir}
}

func resolveNode() string {
	if envPath := strings.TrimSpace(os.Getenv("NODE_BIN")); envPath != "" {
		return envPath
	}
	if path, err := exec.LookPath("node"); err == nil {
		return path
	}
	for _, path := range []string{
		"/opt/homebrew/bin/node",
		"/usr/local/bin/node",
		"/usr/bin/node",
	} {
		if _, err := os.Stat(path); err == nil {
			return path
		}
	}
	return "node"
}

func findCheckoutRoot() (string, bool) {
	seen := map[string]bool{}
	starts := []string{}

	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		starts = append(starts, filepath.Dir(exe))
	}

	for _, start := range starts {
		current := start
		for {
			if !seen[current] {
				seen[current] = true
				if isCheckoutRoot(current) {
					return current, true
				}
			}
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
			current = parent
		}
	}
	return "", false
}

func isCheckoutRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "clawser.mjs")); err != nil {
		return false
	}
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	return strings.Contains(string(data), `"name": "clawser"`)
}
