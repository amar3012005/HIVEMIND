// Package styles centralises all lipgloss styles so the colour palette and
// spacing rules live in one place (matches the Grok TUI aesthetic).
package styles

import "github.com/charmbracelet/lipgloss"

// Palette — muted, dark, high-contrast like the Grok screenshot.
var (
	ColorBG         = lipgloss.Color("#0a0a0a")
	ColorFG         = lipgloss.Color("#e6e6e6")
	ColorMuted      = lipgloss.Color("#5f5f5f")
	ColorDim        = lipgloss.Color("#3a3a3a")
	ColorAccent     = lipgloss.Color("#117dff") // HIVEMIND brand blue
	ColorAccentDim  = lipgloss.Color("#0a4faa")
	ColorSuccess    = lipgloss.Color("#22c55e")
	ColorWarn       = lipgloss.Color("#f59e0b")
	ColorError      = lipgloss.Color("#ef4444")
	ColorBorder     = lipgloss.Color("#1f1f1f")
)

var (
	// App is the outer container; centers content and applies the dark BG.
	App = lipgloss.NewStyle().Padding(1, 2)

	// Logo rendered in a slightly dim accent so it reads as art, not text.
	Logo = lipgloss.NewStyle().
		Foreground(ColorAccent).
		Align(lipgloss.Center).
		MarginBottom(1)

	Wordmark = lipgloss.NewStyle().
			Foreground(ColorFG).
			Bold(true).
			Align(lipgloss.Center).
			MarginBottom(2)

	// Title used for page headings.
	Title = lipgloss.NewStyle().
		Foreground(ColorFG).
		Bold(true).
		MarginBottom(1)

	// Subtitle muted explanatory text under the title.
	Subtitle = lipgloss.NewStyle().
			Foreground(ColorMuted).
			MarginBottom(1)

	// MenuItem default unselected entry — bold label on left.
	MenuItem = lipgloss.NewStyle().
			Foreground(ColorFG).
			Bold(true).
			PaddingLeft(2)

	MenuItemSelected = lipgloss.NewStyle().
				Foreground(ColorAccent).
				Bold(true).
				PaddingLeft(1).
				Border(lipgloss.Border{Left: "▎"}, false, false, false, true).
				BorderForeground(ColorAccent)

	MenuShortcut = lipgloss.NewStyle().
			Foreground(ColorMuted).
			Align(lipgloss.Right)

	Separator = lipgloss.NewStyle().
			Foreground(ColorDim)

	Status = lipgloss.NewStyle().
		Foreground(ColorMuted).
		Italic(true)

	Success = lipgloss.NewStyle().Foreground(ColorSuccess)
	Warn    = lipgloss.NewStyle().Foreground(ColorWarn)
	Errorf  = lipgloss.NewStyle().Foreground(ColorError)

	// Footer fixed bottom bar (version, beta tag).
	Footer = lipgloss.NewStyle().
		Foreground(ColorMuted).
		Align(lipgloss.Right).
		MarginTop(2)

	// Box used for the confirmation / install progress panels.
	Box = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(ColorBorder).
		Padding(1, 2)
)

// MenuRow renders a `label ........... ctrl-x` line that mimics the Grok layout.
// width is the total render width of the menu column.
func MenuRow(label, shortcut string, selected bool, width int) string {
	leftStyle := MenuItem
	if selected {
		leftStyle = MenuItemSelected
	}
	left := leftStyle.Render(label)
	right := MenuShortcut.Render(shortcut)
	gap := width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}
	spacer := lipgloss.NewStyle().Foreground(ColorDim).Render(repeat(" ", gap))
	return left + spacer + right
}

func repeat(s string, n int) string {
	out := ""
	for i := 0; i < n; i++ {
		out += s
	}
	return out
}
