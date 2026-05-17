// Package clients defines the supported MCP host applications and their
// per-platform configuration paths plus install routines.
//
// Each Client implements:
//   - Detect():   does the binary / config dir already exist on this machine?
//   - Install():  write or merge the HIVEMIND MCP entry into the host config
//   - PostInstall(): hint or restart instruction for the user
//
// All install flows MUST be idempotent — running twice should not duplicate
// entries.
package clients

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// ID is the stable identifier for a supported host application.
type ID string

const (
	IDClaudeDesktop ID = "claude-desktop"
	IDClaudeCode    ID = "claude-code"
	IDCodex         ID = "codex"
	IDAntigravity   ID = "antigravity"
	IDVSCode        ID = "vscode"
)

// Client is a single supported MCP host.
type Client struct {
	ID          ID
	Name        string
	Description string
	Shortcut    string // visual hint shown in the menu (e.g. "ctrl-c")
}

// AllClients is the canonical ordered list rendered in the menu.
var AllClients = []Client{
	{IDClaudeCode, "Claude Code", "Anthropic CLI · `claude mcp add`", "ctrl-1"},
	{IDClaudeDesktop, "Claude Desktop", "claude_desktop_config.json", "ctrl-2"},
	{IDCodex, "Codex", "~/.codex/config.toml", "ctrl-3"},
	{IDAntigravity, "Antigravity", "~/.antigravity/mcp.json", "ctrl-4"},
	{IDVSCode, "VS Code", "settings.json · mcp.servers", "ctrl-5"},
}

// Config carries the endpoint + API key the installer received from the
// HIVEMIND control plane. All client writers reference this struct.
type Config struct {
	Endpoint string // e.g. https://core.hivemind.davinciai.eu:8050/api/mcp
	APIKey   string
}

// Install dispatches to the per-client writer.
func Install(id ID, cfg Config) error {
	switch id {
	case IDClaudeCode:
		return installClaudeCode(cfg)
	case IDClaudeDesktop:
		return installClaudeDesktop(cfg)
	case IDCodex:
		return installCodex(cfg)
	case IDAntigravity:
		return installAntigravity(cfg)
	case IDVSCode:
		return installVSCode(cfg)
	}
	return fmt.Errorf("unknown client: %s", id)
}

// ── Claude Code (CLI) ─────────────────────────────────────────────────────
// Uses the official `claude` binary to register the MCP entry idempotently.
func installClaudeCode(cfg Config) error {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return errors.New("`claude` CLI not on PATH — install from https://claude.ai/install.sh first")
	}
	// Remove from every scope first so reinstall is always clean (matches
	// the legacy shell installer behaviour).
	for _, scope := range []string{"user", "local", "project"} {
		_ = exec.Command(bin, "mcp", "remove", "hivemind", "-s", scope).Run()
	}
	args := []string{
		"mcp", "add",
		"--scope", "user",
		"--transport", "http",
		"hivemind", cfg.Endpoint,
		"--header", "Authorization: Bearer " + cfg.APIKey,
	}
	out, err := exec.Command(bin, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("claude mcp add failed: %s", string(out))
	}
	return nil
}

// ── Claude Desktop (JSON config) ──────────────────────────────────────────
// claude_desktop_config.json lives at OS-specific paths.
func claudeDesktopConfigPath() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "Claude", "claude_desktop_config.json")
	default:
		// Linux: Claude Desktop is unofficial; place under ~/.config/Claude.
		return filepath.Join(home, ".config", "Claude", "claude_desktop_config.json")
	}
}

func installClaudeDesktop(cfg Config) error {
	p := claudeDesktopConfigPath()
	return mergeJSONMCPServer(p, "hivemind", map[string]any{
		"type": "http",
		"url":  cfg.Endpoint,
		"headers": map[string]string{
			"Authorization": "Bearer " + cfg.APIKey,
		},
	}, "mcpServers")
}

// ── Codex (TOML) ──────────────────────────────────────────────────────────
// Codex configs live at ~/.codex/config.toml. The TUI writes a minimal
// `[mcp_servers.hivemind]` block, replacing any existing one.
func codexConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".codex", "config.toml")
}

func installCodex(cfg Config) error {
	p := codexConfigPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	block := fmt.Sprintf(`
[mcp_servers.hivemind]
type = "http"
url = "%s"
headers = { Authorization = "Bearer %s" }
`, cfg.Endpoint, cfg.APIKey)

	existing, _ := os.ReadFile(p)
	merged := stripTomlBlock(string(existing), "mcp_servers.hivemind") + block
	return os.WriteFile(p, []byte(merged), 0o600)
}

// ── Antigravity (JSON) ────────────────────────────────────────────────────
// Google Antigravity uses ~/.antigravity/mcp.json (mcpServers map, same
// shape as Claude Desktop).
func antigravityConfigPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".antigravity", "mcp.json")
}

func installAntigravity(cfg Config) error {
	p := antigravityConfigPath()
	return mergeJSONMCPServer(p, "hivemind", map[string]any{
		"type": "http",
		"url":  cfg.Endpoint,
		"headers": map[string]string{
			"Authorization": "Bearer " + cfg.APIKey,
		},
	}, "mcpServers")
}

// ── VS Code (settings.json) ───────────────────────────────────────────────
// VS Code reads MCP servers from User settings under `mcp.servers`.
// We merge into the user-scope settings.json (not workspace) so it works
// across all projects.
func vscodeConfigPath() string {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Code", "User", "settings.json")
	case "windows":
		return filepath.Join(os.Getenv("APPDATA"), "Code", "User", "settings.json")
	default:
		return filepath.Join(home, ".config", "Code", "User", "settings.json")
	}
}

func installVSCode(cfg Config) error {
	p := vscodeConfigPath()
	return mergeJSONMCPServer(p, "hivemind", map[string]any{
		"type": "http",
		"url":  cfg.Endpoint,
		"headers": map[string]string{
			"Authorization": "Bearer " + cfg.APIKey,
		},
	}, "mcp.servers")
}

// ── Helpers ───────────────────────────────────────────────────────────────

// mergeJSONMCPServer reads a JSON config file, inserts/overwrites the named
// entry under the given top-level key (supports dotted key path), and writes
// it back atomically. Missing file/dir is created.
func mergeJSONMCPServer(path, name string, entry map[string]any, topKey string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	root := map[string]any{}
	if err == nil && len(raw) > 0 {
		if err := json.Unmarshal(raw, &root); err != nil {
			return fmt.Errorf("existing config is not valid JSON: %w", err)
		}
	}

	// Walk / create dotted path: e.g. "mcp.servers".
	cur := root
	parts := splitDotPath(topKey)
	for i, k := range parts {
		if i == len(parts)-1 {
			servers, _ := cur[k].(map[string]any)
			if servers == nil {
				servers = map[string]any{}
			}
			servers[name] = entry
			cur[k] = servers
			break
		}
		next, _ := cur[k].(map[string]any)
		if next == nil {
			next = map[string]any{}
		}
		cur[k] = next
		cur = next
	}

	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, out, 0o600)
}

func splitDotPath(s string) []string {
	parts := []string{}
	cur := ""
	for _, r := range s {
		if r == '.' {
			parts = append(parts, cur)
			cur = ""
			continue
		}
		cur += string(r)
	}
	if cur != "" {
		parts = append(parts, cur)
	}
	return parts
}

// stripTomlBlock removes a `[section]` block (until the next `[` or EOF)
// from a TOML document so the installer can rewrite it cleanly.
func stripTomlBlock(doc, section string) string {
	header := "[" + section + "]"
	idx := indexOf(doc, header)
	if idx < 0 {
		return doc
	}
	// Find the next `\n[` after our header to know where the block ends.
	end := idx + len(header)
	for end < len(doc) {
		if doc[end] == '\n' && end+1 < len(doc) && doc[end+1] == '[' {
			break
		}
		end++
	}
	return doc[:idx] + doc[end:]
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

// ConfigPathFor returns the on-disk config path for a client (for display).
func ConfigPathFor(id ID) string {
	switch id {
	case IDClaudeCode:
		return "(managed by `claude` CLI)"
	case IDClaudeDesktop:
		return claudeDesktopConfigPath()
	case IDCodex:
		return codexConfigPath()
	case IDAntigravity:
		return antigravityConfigPath()
	case IDVSCode:
		return vscodeConfigPath()
	}
	return ""
}
