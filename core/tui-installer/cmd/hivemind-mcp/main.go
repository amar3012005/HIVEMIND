// hivemind-mcp is the terminal UI installer for the HIVEMIND MCP server.
//
// Single static binary. Run with no args and the user picks the host
// application (Claude Code / Desktop / Codex / Antigravity / VS Code) from
// a Grok-style TUI. The endpoint is baked in via -ldflags at build time;
// the API key is read from $HIVEMIND_API_KEY or prompted interactively.
//
// Build:
//   make build           # current OS
//   make release         # mac+linux+windows fat fan-out
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/hivemind/tui-installer/internal/model"
)

// These are overridden via -ldflags at build time.
var (
	defaultEndpoint = "https://core.hivemind.davinciai.eu:8050/api/mcp"
	version         = "0.1.0"
)

func main() {
	endpoint := flag.String("endpoint", defaultEndpoint, "HIVEMIND MCP endpoint URL")
	apiKey := flag.String("api-key", os.Getenv("HIVEMIND_API_KEY"), "HIVEMIND API key (or set HIVEMIND_API_KEY)")
	flag.Parse()

	p := tea.NewProgram(
		model.New(*endpoint, *apiKey, version),
		tea.WithAltScreen(),
		tea.WithMouseCellMotion(),
	)
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "hivemind-mcp:", err)
		os.Exit(1)
	}
}
