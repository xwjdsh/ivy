// Ivy's app: a thin shell around `ivy daemon` (DESIGN.md §5.7), in the menu bar and, while
// the chat window is open, in the Dock. It keeps the daemon running, shows its reminders
// as notifications of Ivy's own, shows the chat window (the daemon's web page), starts at
// login, and installs the `ivy` command. All of Ivy's logic stays in the daemon.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

// trayIcon is Ivy's silhouette in the menu bar, a template image made by tools/icongen.
//
//go:embed resources/tray.png
var trayIcon []byte

func main() {
	if !mygo.App.RequestSingleInstanceLock() {
		return // already running
	}
	// `mygo build` runs the app with MYGO_GENERATE set to write the frontend's client, which
	// binds nothing here: the app needs nothing set up then, and finding its folders would
	// make new ones named after that run (Logs/Ivy-<pid>).
	if os.Getenv("MYGO_GENERATE") != "" {
		if err := mygo.App.Run(); err != nil {
			log.Fatal(err)
		}
		return
	}
	logs, _ := mygo.App.Path(mygo.PathLogs)
	if f, err := os.OpenFile(filepath.Join(logs, "app.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600); err == nil {
		log.SetOutput(f)
	}

	// Before any window: the chat window's requests go to the daemon, and it opens in the
	// appearance picked last.
	loadAppearance()
	if err := mygo.Protocol.Handle(daemonScheme, schemeHandler(socketPath())); err != nil {
		log.Fatal(err)
	}

	var sup *supervisor
	mygo.App.WhenReady(func() {
		mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory) // menu bar only, no Dock icon
		menu := newMenu()
		if _, err := mygo.NewTray(mygo.TrayOptions{
			Icon:           trayIcon,
			IconIsTemplate: true, // tinted for light and dark menu bars
			ToolTip:        "Ivy",
			Menu:           menu,
		}); err != nil {
			log.Printf("tray: %v", err)
		}

		// Ivy stays in the menu bar when the chat window closes; Quit Ivy quits.
		mygo.App.OnWindowAllClosed(func() {})
		// A click on the Dock icon, or on a reminder, opens the chat.
		mygo.App.OnActivate(func(hasVisibleWindows bool) {
			if !hasVisibleWindows {
				openChat()
			}
		})
		mygo.App.OnNotificationClick(func(string) { openChat() })

		status := newStatus(menu)
		if problem := socketProblem(); problem != "" {
			status.setProblem(problem)
			return
		}
		bin, err := ivyBinary()
		if err != nil {
			status.setProblem(err.Error())
		} else {
			sup = newSupervisor(bin, filepath.Join(logs, "daemon.log"), status.setProblem)
			go sup.run()
		}
		go follow(status)
	})
	mygo.App.OnQuit(func() {
		if sup != nil {
			sup.stop()
		}
	})
	// SIGTERM (a logout, kill) quits like Quit Ivy does, so the daemon stops with the app.
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		mygo.App.Quit()
	}()
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

// ivyBinary is the ivy binary shipped in the app (resources/darwin-arm64/bin/ivy, put
// there by scripts/build-app.ts), or IVY_BIN in development.
func ivyBinary() (string, error) {
	if bin := os.Getenv("IVY_BIN"); bin != "" {
		return bin, nil
	}
	dir, err := mygo.App.Path(mygo.PathResources)
	if err != nil {
		return "", err
	}
	bin := filepath.Join(dir, "bin", "ivy")
	if _, err := os.Stat(bin); err != nil {
		return "", fmt.Errorf("the ivy binary is missing from the app (%s)", bin)
	}
	return bin, nil
}

func newMenu() *mygo.Menu {
	return mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Open Ivy", Click: func(*mygo.MenuItem, *mygo.Window) { openChat() }},
		mygo.Separator(),
		{ID: "status", Label: "Starting…", Disabled: true},
		mygo.Separator(),
		{
			ID:      "login",
			Label:   "Start at Login",
			Type:    mygo.MenuItemCheckbox,
			Checked: mygo.App.OpenAtLogin(),
			Click: func(item *mygo.MenuItem, _ *mygo.Window) {
				if err := mygo.App.SetOpenAtLogin(item.Checked); err != nil {
					log.Printf("start at login: %v", err)
					item.SetChecked(mygo.App.OpenAtLogin())
				}
			},
		},
		{Label: "Install the ivy Command", Click: func(*mygo.MenuItem, *mygo.Window) { go installCommand() }},
		mygo.Separator(),
		{Label: "Quit Ivy", Role: mygo.RoleQuit},
	})
}

// status is the first item of the menu: whether the daemon runs and is followed.
type status struct {
	item      *mygo.MenuItem
	problem   string
	connected bool
}

func newStatus(menu *mygo.Menu) *status { return &status{item: menu.ItemByID("status")} }

func (s *status) setProblem(problem string) {
	s.problem = problem
	s.show()
}

func (s *status) setConnected(connected bool) {
	s.connected = connected
	s.show()
}

func (s *status) show() {
	switch {
	case s.connected:
		s.item.SetLabel("Ivy is running")
	case s.problem != "":
		s.item.SetLabel(s.problem)
	default:
		s.item.SetLabel("Starting…")
	}
}

// follow keeps a subscription to the daemon's events, reconnecting while it restarts.
func follow(s *status) {
	for {
		if problem := protocolProblem(socketPath()); problem != "" {
			s.setProblem(problem)
			time.Sleep(5 * time.Second)
			continue
		}
		err := followEvents(context.Background(), socketPath(), func(e event) {
			switch e.Type {
			case "connected":
				s.setConnected(true)
			case "reminder":
				var r reminder
				if err := json.Unmarshal(e.Data, &r); err != nil {
					log.Printf("reminder: %v", err)
					return
				}
				go notify(r)
			}
		})
		s.setConnected(false)
		if err != nil {
			log.Printf("events: %v", err)
		}
		time.Sleep(time.Second)
	}
}

// notify shows a reminder as a notification of Ivy's own. The first one asks the user to
// allow notifications, and waits for the answer.
func notify(r reminder) {
	n := mygo.NewNotification(mygo.NotificationOptions{
		ID:    r.ID,
		Title: r.Title,
		Body:  r.Body,
		Group: "reminders",
	})
	if err := n.Show(); err != nil {
		log.Printf("notification: %v", err)
	}
}

// commandLink is where the `ivy` command is installed: a link to the binary in the app,
// so the terminal and the app run the same version.
const commandLink = "/usr/local/bin/ivy"

// installCommand links commandLink to the app's binary, asking for an administrator's
// password when /usr/local/bin isn't writable, as editors install their commands.
func installCommand() {
	bin, err := ivyBinary()
	if err == nil {
		err = os.MkdirAll(filepath.Dir(commandLink), 0o755)
		if err == nil {
			_ = os.Remove(commandLink)
			err = os.Symlink(bin, commandLink)
		}
		if err != nil {
			script := fmt.Sprintf(
				`do shell script "mkdir -p %s && ln -sf %s %s" with administrator privileges`,
				shellQuote(filepath.Dir(commandLink)), shellQuote(bin), shellQuote(commandLink),
			)
			if out, aerr := exec.Command("osascript", "-e", script).CombinedOutput(); aerr != nil {
				err = fmt.Errorf("%v: %s", aerr, strings.TrimSpace(string(out)))
			} else {
				err = nil
			}
		}
	}
	body := "Type ivy in a terminal to talk to Ivy."
	if err != nil {
		body = err.Error()
		log.Printf("install command: %v", err)
	}
	title := "The ivy command is installed"
	if err != nil {
		title = "Couldn't install the ivy command"
	}
	_ = mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body}).Show()
}

// shellQuote quotes a path for `do shell script`, inside AppleScript's double quotes.
func shellQuote(s string) string {
	return `'` + strings.ReplaceAll(strings.ReplaceAll(s, `'`, `'\''`), `"`, `\"`) + `'`
}
