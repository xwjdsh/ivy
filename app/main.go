// Ivy's app: a thin shell around `ivy daemon` (docs/design/interfaces.md), in the Dock. It keeps
// the daemon running, shows its reminders as notifications of Ivy's own, shows the chat window (the
// app's web page, a client of the daemon), starts at login, and installs the `ivy` command. All of
// Ivy's logic stays in the daemon.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

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
	status := &status{}
	if err := mygo.Protocol.Handle(daemonScheme, schemeHandler(socketPath(), status.why)); err != nil {
		log.Fatal(err)
	}
	mygo.App.SetMenu(appMenu())
	mygo.App.Dock.SetMenu(dockMenu())

	var sup *supervisor
	mygo.App.WhenReady(func() {
		// Ivy keeps running when the chat window is closed (it only hides); Quit quits.
		mygo.App.OnWindowAllClosed(func() {})
		// A click on the Dock icon, or on a reminder, opens the chat.
		mygo.App.OnActivate(func(hasVisibleWindows bool) {
			if !hasVisibleWindows {
				openChat()
			}
		})
		mygo.App.OnNotificationClick(func(string) { openChat() })
		// Started at login, Ivy waits in the Dock; started by hand, the user came to talk.
		if !mygo.App.WasOpenedAtLogin() {
			openChat()
		}

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
	// Quitting closes the chat window for good, where closing it otherwise only hides it.
	mygo.App.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	mygo.App.OnQuit(func() {
		if sup != nil {
			sup.stop()
		}
	})
	// SIGTERM (a logout, kill) quits like ⌘Q does, so the daemon stops with the app.
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

// appMenu is the menu bar's: the app menu as every Mac app has it, with Settings… (⌘,) in its
// usual place, and the Edit and Window menus, which copy, paste and ⌘W need.
func appMenu() *mygo.Menu {
	return mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Ivy", Submenu: []*mygo.MenuItem{
			{Role: mygo.RoleAbout},
			mygo.Separator(),
			{Label: "Settings…", Accelerator: "CmdOrCtrl+,", Click: func(*mygo.MenuItem, *mygo.Window) { openSettings() }},
			mygo.Separator(),
			{Role: mygo.RoleServices},
			mygo.Separator(),
			{Role: mygo.RoleHide},
			{Role: mygo.RoleHideOthers},
			{Role: mygo.RoleUnhide},
			mygo.Separator(),
			{Role: mygo.RoleQuit},
		}},
		{Role: mygo.RoleEditMenu},
		{Role: mygo.RoleWindowMenu},
	})
}

// dockMenu adds to the Dock icon's menu what is set once and rarely again.
func dockMenu() *mygo.Menu {
	return mygo.NewMenu([]*mygo.MenuItem{
		{
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
	})
}

// status is why the daemon isn't running, if the app knows: the chat window is told when it
// can't reach the daemon. The supervisor and the event follower set it from their goroutines.
type status struct {
	mu      sync.Mutex
	problem string
}

func (s *status) setProblem(problem string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.problem = problem
}

func (s *status) why() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.problem
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
				s.setProblem("") // it answers
			case "reminder":
				var r reminder
				if err := json.Unmarshal(e.Data, &r); err != nil {
					log.Printf("reminder: %v", err)
					return
				}
				go notify(r)
			}
		})
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
// so the terminal and the app run the same version; `ivy-dev` for the development app.
func commandLink() string {
	if devApp() {
		return "/usr/local/bin/ivy-dev"
	}
	return "/usr/local/bin/ivy"
}

// installCommand links the command from the Dock icon's menu, and tells how it went.
func installCommand() {
	err := linkCommand()
	title, body := "The ivy command is installed", "Type ivy in a terminal to talk to Ivy."
	if err != nil {
		log.Printf("install command: %v", err)
		title, body = "Couldn't install the ivy command", err.Error()
	}
	_ = mygo.NewNotification(mygo.NotificationOptions{Title: title, Body: body}).Show()
}

// linkCommand links commandLink to the app's binary, asking for an administrator's password
// when /usr/local/bin isn't writable, as editors install their commands.
func linkCommand() error {
	bin, err := ivyBinary()
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(commandLink()), 0o755); err == nil {
		_ = os.Remove(commandLink())
		err = os.Symlink(bin, commandLink())
	}
	if err == nil {
		return nil
	}
	script := fmt.Sprintf(
		`do shell script "mkdir -p %s && ln -sf %s %s" with administrator privileges`,
		shellQuote(filepath.Dir(commandLink())), shellQuote(bin), shellQuote(commandLink()),
	)
	if out, err := exec.Command("osascript", "-e", script).CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// commandInstalled tells whether commandLink leads to the app's binary.
func commandInstalled() bool {
	bin, err := ivyBinary()
	if err != nil {
		return false
	}
	target, err := filepath.EvalSymlinks(commandLink())
	if err != nil {
		return false
	}
	want, err := filepath.EvalSymlinks(bin)
	return err == nil && target == want
}

// shellQuote quotes a path for `do shell script`, inside AppleScript's double quotes.
func shellQuote(s string) string {
	return `'` + strings.ReplaceAll(strings.ReplaceAll(s, `'`, `'\''`), `"`, `\"`) + `'`
}
