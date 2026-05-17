// Package model holds the Bubble Tea state machine for the HIVEMIND MCP
// installer. Three screens:
//
//  1. menu       — main client picker (Grok-style list)
//  2. apikey     — prompt for an API key if one wasn't passed via env/flag
//  3. installing — show progress + result for the selected client
//  4. done       — success screen with next-step shortcuts
package model

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/hivemind/tui-installer/internal/clients"
	"github.com/hivemind/tui-installer/internal/logo"
	"github.com/hivemind/tui-installer/internal/styles"
)

type screen int

const (
	screenMenu screen = iota
	screenAPIKey
	screenInstalling
	screenDone
)

// installResultMsg is dispatched when the client install goroutine returns.
type installResultMsg struct {
	err error
}

// Model is the root Bubble Tea model.
type Model struct {
	screen   screen
	cursor   int
	clients  []clients.Client
	selected clients.Client

	endpoint string
	apiKey   string

	apiInput textinput.Model
	spinner  spinner.Model

	width  int
	height int

	resultErr error
	version   string
}

// New constructs the initial model.
func New(endpoint, apiKey, version string) Model {
	ti := textinput.New()
	ti.Placeholder = "hm_live_..."
	ti.Prompt = "› "
	ti.EchoMode = textinput.EchoPassword
	ti.CharLimit = 200
	ti.Width = 50
	ti.Focus()

	sp := spinner.New()
	sp.Spinner = spinner.Dot
	sp.Style = lipgloss.NewStyle().Foreground(styles.ColorAccent)

	startScreen := screenMenu
	if apiKey == "" {
		startScreen = screenAPIKey
	}

	return Model{
		screen:   startScreen,
		clients:  clients.AllClients,
		endpoint: endpoint,
		apiKey:   apiKey,
		apiInput: ti,
		spinner:  sp,
		version:  version,
	}
}

// Init satisfies tea.Model.
func (m Model) Init() tea.Cmd {
	return tea.Batch(textinput.Blink, m.spinner.Tick)
}

// Update is the master dispatcher.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "ctrl+d":
			return m, tea.Quit
		}
		switch m.screen {
		case screenMenu:
			return m.updateMenu(msg)
		case screenAPIKey:
			return m.updateAPIKey(msg)
		case screenDone:
			return m.updateDone(msg)
		}

	case installResultMsg:
		m.resultErr = msg.err
		m.screen = screenDone
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m Model) updateMenu(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.clients)-1 {
			m.cursor++
		}
	case "enter", " ":
		m.selected = m.clients[m.cursor]
		m.screen = screenInstalling
		return m, m.runInstall()
	}
	return m, nil
}

func (m Model) updateAPIKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter":
		val := strings.TrimSpace(m.apiInput.Value())
		if val == "" {
			return m, nil
		}
		m.apiKey = val
		m.screen = screenMenu
		return m, nil
	}
	var cmd tea.Cmd
	m.apiInput, cmd = m.apiInput.Update(msg)
	return m, cmd
}

func (m Model) updateDone(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "enter", "esc", "q":
		return m, tea.Quit
	case "r":
		// Restart at menu to install another client.
		m.screen = screenMenu
		m.resultErr = nil
		return m, nil
	}
	return m, nil
}

// runInstall returns a tea.Cmd that performs the install off the UI thread.
func (m Model) runInstall() tea.Cmd {
	cfg := clients.Config{Endpoint: m.endpoint, APIKey: m.apiKey}
	id := m.selected.ID
	return func() tea.Msg {
		return installResultMsg{err: clients.Install(id, cfg)}
	}
}

// View renders the current screen.
func (m Model) View() string {
	header := styles.Logo.Render(logo.HivemindLogo) +
		styles.Wordmark.Render(logo.HivemindWordmark)

	footer := styles.Footer.Width(m.width - 4).Render(
		fmt.Sprintf("%s  Beta", m.version),
	)

	var body string
	switch m.screen {
	case screenMenu:
		body = m.viewMenu()
	case screenAPIKey:
		body = m.viewAPIKey()
	case screenInstalling:
		body = m.viewInstalling()
	case screenDone:
		body = m.viewDone()
	}

	return styles.App.Render(
		lipgloss.JoinVertical(lipgloss.Left,
			header,
			body,
			footer,
		),
	)
}

func (m Model) viewMenu() string {
	const menuWidth = 56

	rows := []string{}
	for i, c := range m.clients {
		rows = append(rows,
			styles.MenuRow(c.Name, c.Shortcut, i == m.cursor, menuWidth),
		)
	}
	rows = append(rows,
		"",
		styles.MenuRow("Quit", "ctrl-d", false, menuWidth),
	)

	help := styles.Subtitle.Render(
		"↑/↓ move  ·  enter install  ·  ctrl-d quit",
	)
	endpoint := styles.Status.Render("endpoint  " + m.endpoint)

	block := lipgloss.JoinVertical(lipgloss.Left, rows...)
	centered := lipgloss.NewStyle().Width(m.width - 4).Align(lipgloss.Center).Render(block)
	return lipgloss.JoinVertical(lipgloss.Left, centered, "", help, endpoint)
}

func (m Model) viewAPIKey() string {
	title := styles.Title.Render("Paste your HIVEMIND API key")
	hint := styles.Subtitle.Render(
		"Get one at https://hivemind.davinciai.eu → Settings → API Keys",
	)
	box := styles.Box.Width(60).Render(m.apiInput.View())
	help := styles.Subtitle.Render("enter continue  ·  ctrl-d quit")
	return lipgloss.JoinVertical(lipgloss.Left, title, hint, box, "", help)
}

func (m Model) viewInstalling() string {
	title := styles.Title.Render("Installing " + m.selected.Name + "…")
	path := styles.Status.Render("→ " + clients.ConfigPathFor(m.selected.ID))
	line := m.spinner.View() + "  " + styles.Status.Render("writing MCP config")
	return lipgloss.JoinVertical(lipgloss.Left, title, path, "", line)
}

func (m Model) viewDone() string {
	var title, detail string
	if m.resultErr != nil {
		title = styles.Errorf.Bold(true).Render("✗ " + m.selected.Name + " setup failed")
		detail = styles.Errorf.Render(m.resultErr.Error())
	} else {
		title = styles.Success.Bold(true).Render("✓ " + m.selected.Name + " connected to HIVEMIND")
		detail = styles.Status.Render("Config written to " + clients.ConfigPathFor(m.selected.ID))
	}
	next := styles.Subtitle.Render("r install another  ·  enter quit")
	return lipgloss.JoinVertical(lipgloss.Left, title, detail, "", next)
}
