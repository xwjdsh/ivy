// The settings page (DESIGN.md §5.7), in the window in place of the conversation, by section.
// What can be changed here is changed in place: the providers in config.toml, a line or a
// table at a time, their keys in the Keychain, never shown back. Permissions and plugins are
// shown, and changed in config.toml, one click away.

import type { DaemonState, ProviderInfo, Settings } from "@ivy/protocol";
import { ExternalLink, KeyRound, Plus } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { PickMany } from "./menu.tsx";
import { Appearances, inApp, ModelSettings, modelName, sources } from "./profile.tsx";

const SECTIONS = ["General", "Models", "Permissions", "Plugins", "About"] as const;
type Section = (typeof SECTIONS)[number];

export function SettingsPage(props: {
  state: DaemonState | undefined;
  onState(state: DaemonState): void;
  onError(err: unknown): void;
}) {
  const { onError } = props;
  const [section, setSection] = useState<Section>("General");
  const [settings, setSettings] = useState<Settings | undefined>();
  useEffect(() => {
    api.settings().then(setSettings, onError);
  }, [onError]);
  /** After a provider changed: what the daemon now offers, model list included. */
  const changed = useCallback(
    (next: Settings) => {
      setSettings(next);
      api.state().then(props.onState, onError);
    },
    [props.onState, onError],
  );

  return (
    <div className="st-page">
      <nav aria-label="Settings">
        {SECTIONS.map((s) => (
          <button
            key={s}
            type="button"
            className="st-section"
            aria-current={s === section ? "page" : undefined}
            onClick={() => setSection(s)}
          >
            {s}
          </button>
        ))}
      </nav>
      <div className="st-body">
        <h2>{section}</h2>
        {section === "General" && <General onError={onError} />}
        {section === "Models" && (
          <Models
            state={props.state}
            settings={settings}
            onState={props.onState}
            onChanged={changed}
            onError={onError}
          />
        )}
        {section === "Permissions" && settings && (
          <Permissions settings={settings} onError={onError} />
        )}
        {section === "Plugins" && settings && <Plugins settings={settings} onError={onError} />}
        {section === "About" && settings && <About settings={settings} onError={onError} />}
      </div>
    </div>
  );
}

/** A labelled row: what it is on the left, the control on the right, a note under it. */
function Row(props: { label: string; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="st-row">
      <div className="st-what">
        <span className="st-label">{props.label}</span>
        {props.note && <span className="st-note">{props.note}</span>}
      </div>
      <div className="st-control">{props.children}</div>
    </div>
  );
}

/** "Open config.toml": where what is only shown here is changed. */
function OpenConfig({ onError }: { onError(err: unknown): void }) {
  if (!inApp) return null;
  return (
    <button
      type="button"
      className="ghost st-open"
      onClick={() => api.open("config").catch(onError)}
    >
      Open config.toml
      <ExternalLink size={13} />
    </button>
  );
}

function General({ onError }: { onError(err: unknown): void }) {
  const [login, setLogin] = useState<boolean | undefined>();
  const [command, setCommand] = useState<{ installed: boolean; path: string } | undefined>();
  useEffect(() => {
    if (!inApp) return;
    api.login().then(setLogin, onError);
    api.command().then(setCommand, onError);
  }, [onError]);
  if (!inApp) {
    return (
      <p className="st-hint">These are the app's own settings: open Ivy's app to change them.</p>
    );
  }
  return (
    <section>
      <Row label="Appearance">
        <Appearances onError={onError} />
      </Row>
      <Row label="Start at login" note="Ivy waits in the Dock, reminders coming on time.">
        <input
          type="checkbox"
          className="st-switch"
          checked={login ?? false}
          disabled={login === undefined}
          onChange={(e) => api.setLogin(e.target.checked).then(setLogin, onError)}
        />
      </Row>
      <Row
        label="The ivy command"
        note={
          command &&
          (command.installed ? `Installed at ${command.path}` : "Talk to Ivy in a terminal")
        }
      >
        <button
          type="button"
          className="ghost"
          disabled={!command}
          onClick={() => api.installCommand().then(setCommand, onError)}
        >
          {command?.installed ? "Install again" : "Install"}
        </button>
      </Row>
    </section>
  );
}

function Models(props: {
  state: DaemonState | undefined;
  settings: Settings | undefined;
  onState(state: DaemonState): void;
  onChanged(settings: Settings): void;
  onError(err: unknown): void;
}) {
  const { settings, onChanged, onError } = props;
  const [adding, setAdding] = useState(false);
  return (
    <section>
      {props.state && (
        <div className="st-current">
          <ModelSettings
            // Asked again for the models when the providers change.
            key={JSON.stringify(settings?.providers)}
            state={props.state}
            onState={props.onState}
            onError={onError}
          />
        </div>
      )}
      <h3>Providers</h3>
      <p className="st-hint">
        Where models are reached. A provider's models are offered once it is added: the ones its
        endpoint lists, or only those you name.
      </p>
      {settings?.providers.map((p) => (
        <Provider key={p.name} provider={p} keychain={settings.keychain} onChanged={onChanged} />
      ))}
      {adding ? (
        <AddProvider
          keychain={settings?.keychain ?? false}
          onAdded={(next) => {
            onChanged(next);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button type="button" className="ghost st-add" onClick={() => setAdding(true)}>
          <Plus size={14} />
          Add a provider
        </button>
      )}
    </section>
  );
}

/** The protocols a provider can speak (DESIGN.md §5.2.1), and where each vendor's own API is. */
const PROTOCOLS: Record<string, { name: string; vendor: string; url: string }> = {
  anthropic: { name: "Anthropic", vendor: "Anthropic API", url: "https://api.anthropic.com" },
  openai: { name: "OpenAI", vendor: "OpenAI API", url: "https://api.openai.com/v1" },
};
const protocolOf = (type: string) => PROTOCOLS[type] ?? { name: type, vendor: type, url: "" };

const KEY_TEXT: Record<ProviderInfo["key"], string> = {
  keychain: "Key in the Keychain",
  config: "Key in config.toml",
  none: "No key",
};

/** One provider: where it is, where its key is, what it offers; changed in place. What goes
 * wrong shows on it. */
function Provider(props: {
  provider: ProviderInfo;
  keychain: boolean;
  onChanged(settings: Settings): void;
}) {
  const { provider: p, onChanged } = props;
  const [editing, setEditing] = useState(false);
  const [keying, setKeying] = useState(false);
  const [baseUrl, setBaseUrl] = useState(p.official ? "" : p.base_url);
  const [models, setModels] = useState(p.models.join("\n"));
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const listing = useListing(
    editing
      ? { name: p.name, type: p.type, base_url: p.official ? "" : p.base_url, key: "" }
      : undefined,
  );

  const run = async (action: () => Promise<Settings>, after?: () => void) => {
    setBusy(true);
    setProblem(undefined);
    try {
      onChanged(await action());
      after?.();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-provider">
      <div className="st-head">
        <span className="st-name">{p.name}</span>
        {p.inUse && <span className="st-badge">In use</span>}
        <span className="st-where">{p.official ? protocolOf(p.type).vendor : p.base_url}</span>
      </div>
      <div className="st-info">
        <span className={`st-key st-key-${p.key}`}>
          <KeyRound size={12} />
          {KEY_TEXT[p.key]}
        </span>
        <span>{protocolOf(p.type).name} protocol</span>
        <span>{p.models.length ? p.models.join(", ") : "Every model the endpoint lists"}</span>
      </div>

      {editing && (
        <div className="st-form">
          <label>
            Endpoint
            <input
              value={baseUrl}
              placeholder={protocolOf(p.type).url}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <OnlyModels listing={listing} text={models} onText={setModels} />
          <div className="st-actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                // What was changed and not saved goes.
                setBaseUrl(p.official ? "" : p.base_url);
                setModels(p.models.join("\n"));
                setEditing(false);
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                run(
                  () =>
                    api.updateProvider(p.name, {
                      base_url: baseUrl.trim(),
                      models: lines(models),
                    }),
                  () => setEditing(false),
                )
              }
            >
              Save
            </button>
          </div>
        </div>
      )}

      {keying && (
        <div className="st-form">
          <label>
            API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              placeholder="Stored in the Keychain, never shown again"
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
          <div className="st-actions">
            <button type="button" className="ghost" onClick={() => setKeying(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy || !key.trim()}
              onClick={() =>
                run(
                  async () => {
                    // Only a key that reaches the endpoint is kept.
                    await api.testProvider({
                      type: p.type,
                      base_url: p.official ? "" : p.base_url,
                      key,
                    });
                    return api.setKey(p.name, key);
                  },
                  () => {
                    setKey("");
                    setKeying(false);
                  },
                )
              }
            >
              {busy ? "Checking…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {!editing && !keying && (
        <div className="st-actions">
          <button type="button" className="ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
          {props.keychain && (
            <button type="button" className="ghost" onClick={() => setKeying(true)}>
              {p.key === "none" ? "Set key" : "Replace key"}
            </button>
          )}
          {props.keychain && p.key === "config" && (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => run(() => api.setKey(p.name))}
            >
              Move key to the Keychain
            </button>
          )}
          {props.keychain && p.key === "keychain" && !p.inUse && (
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() => run(() => api.removeKey(p.name))}
            >
              Remove key
            </button>
          )}
          <button
            type="button"
            className="ghost danger"
            disabled={busy || p.inUse}
            title={p.inUse ? "The model in use is one of its: switch models first" : undefined}
            onClick={() => run(() => api.removeProvider(p.name))}
          >
            Remove
          </button>
        </div>
      )}
      {problem && <p className="st-problem">{problem}</p>}
    </div>
  );
}

/** What an endpoint lists; or, having taken the key, why it lists nothing (its models are named
 * by hand); or why it can't be used. Undefined while it is asked. */
type Listing = { models: string[] } | { unlisted: string } | { error: string } | undefined;

/** The models an endpoint lists with a key (or a provider's own), asked again when what
 * reaches it changes and has settled. */
function useListing(
  target: { name?: string; type: string; base_url: string; key: string } | undefined,
): Listing {
  const [listing, setListing] = useState<Listing>();
  const asked = target && JSON.stringify(target);
  useEffect(() => {
    setListing(undefined);
    if (!asked) return;
    let current = true;
    const timer = setTimeout(() => {
      api.testProvider(JSON.parse(asked)).then(
        (r) => current && setListing(r.unlisted ? { unlisted: r.unlisted } : { models: r.models }),
        (err) => current && setListing({ error: err instanceof Error ? err.message : String(err) }),
      );
    }, 400);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [asked]);
  return listing;
}

/** The models a provider offers, chosen from what its endpoint lists, or named by hand when
 * it lists none; none chosen, all of them. `text` holds one per line. */
function OnlyModels(props: { listing: Listing; text: string; onText(text: string): void }) {
  const { listing } = props;
  const chosen = lines(props.text);
  if (listing && "error" in listing) return <p className="st-problem">{listing.error}</p>;
  if (listing && "unlisted" in listing) {
    return (
      <label>
        Only these models
        <textarea
          rows={3}
          value={props.text}
          placeholder="One per line"
          onChange={(e) => props.onText(e.target.value)}
        />
        <span className="st-note">
          {listing.unlisted.replace(/\.$/, "")}. Name the models it offers.
        </span>
      </label>
    );
  }
  const listed = listing?.models;
  // A chosen model the endpoint no longer lists stays, to be let go of.
  const all = [...(listed ?? []), ...chosen.filter((m) => !listed?.includes(m))];
  const groups = sources(all);
  return (
    <div className="st-field st-models">
      <span className="st-caption">
        Only these models
        {chosen.length > 0 && (
          <button type="button" className="st-link" onClick={() => props.onText("")}>
            Offer every one
          </button>
        )}
      </span>
      {listed === undefined ? (
        <span className="st-listing">Listing the endpoint's models…</span>
      ) : (
        <PickMany
          below
          values={chosen}
          title="The models to offer"
          search="Search models"
          shown={
            chosen.length === 0
              ? "Every model the endpoint lists"
              : chosen.length === 1
                ? chosen[0]
                : `${chosen.length} models`
          }
          options={all.map((m) => ({
            value: m,
            label: modelName(m),
            group: groups.get(m),
            detail: listed.includes(m) ? undefined : "not listed",
          }))}
          onChange={(next) => props.onText(next.join("\n"))}
        />
      )}
    </div>
  );
}

/** A new provider, tested against its endpoint before it is saved. */
function AddProvider(props: {
  keychain: boolean;
  onAdded(settings: Settings): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("anthropic");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [models, setModels] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const listing = useListing(key.trim() ? { type, base_url: baseUrl.trim(), key } : undefined);
  // Only an endpoint that answers with this key is kept, or one whose models are named.
  const reached =
    listing !== undefined &&
    ("models" in listing || ("unlisted" in listing && lines(models).length > 0));

  const add = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      props.onAdded(
        await api.addProvider({
          name: name.trim(),
          type,
          base_url: baseUrl.trim(),
          key,
          models: lines(models),
        }),
      );
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="st-provider st-adding">
      <div className="st-form">
        <label>
          Name
          <input
            // biome-ignore lint/a11y/noAutofocus: the form is opened to fill it in
            autoFocus
            value={name}
            placeholder="anthropic, my-proxy, …"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="st-protocol">
          Protocol
          <div className="segments">
            {Object.entries(PROTOCOLS).map(([value, p]) => (
              <button
                key={value}
                type="button"
                aria-pressed={type === value}
                onClick={() => setType(value)}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <label>
          Endpoint
          <input
            value={baseUrl}
            placeholder={protocolOf(type).url}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            value={key}
            placeholder={props.keychain ? "Stored in the Keychain" : "Needs the Keychain (macOS)"}
            disabled={!props.keychain}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        {key.trim() && <OnlyModels listing={listing} text={models} onText={setModels} />}
        <p className="st-hint">
          Anthropic for the Messages API, OpenAI for Chat Completions, which most other endpoints
          speak. Ivy lists the endpoint's models with this key before anything is saved.
        </p>
        <div className="st-actions">
          <button type="button" className="ghost" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !name.trim() || !reached}
            onClick={add}
          >
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        {problem && <p className="st-problem">{problem}</p>}
      </div>
    </div>
  );
}

const lines = (text: string) =>
  text
    .split(/[\n,]/)
    .map((l) => l.trim())
    .filter(Boolean);

function Permissions(props: { settings: Settings; onError(err: unknown): void }) {
  const { settings } = props;
  const { allow, ask, deny } = settings.permissions;
  return (
    <section>
      <p className="st-hint">
        What runs without asking, what always asks, and what never runs; the rest asks by its risk.{" "}
        <em>Always</em> in a permission prompt adds to the first list.
      </p>
      <Rules name="Allow" rules={allow} />
      <Rules name="Ask" rules={ask} />
      <Rules name="Deny" rules={deny} />
      <h3>Tools</h3>
      <table className="st-tools">
        <tbody>
          {settings.tools.map((t) => (
            <tr key={t.name}>
              <td className="st-name">{t.name}</td>
              <td className={`st-risk st-risk-${t.risk}`}>{t.risk}</td>
              <td className="st-allowed">{t.defaultAllow ? "runs without asking" : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <OpenConfig onError={props.onError} />
    </section>
  );
}

function Rules({ name, rules }: { name: string; rules: string[] }) {
  return (
    <div className="st-rules">
      <span className="st-label">{name}</span>
      {rules.length ? (
        <span className="st-list">
          {rules.map((r) => (
            <code key={r} className="st-rule">
              {r}
            </code>
          ))}
        </span>
      ) : (
        <span className="st-empty">None</span>
      )}
    </div>
  );
}

function Plugins(props: { settings: Settings; onError(err: unknown): void }) {
  const { settings } = props;
  return (
    <section>
      <p className="st-hint">
        Turned on and off, and set, under <code className="st-mono">[plugins.&lt;id&gt;]</code> in
        config.toml.
      </p>
      {settings.plugins.map((p) => (
        <div key={p.id} className="st-plugin">
          <div className="st-head">
            <span className="st-name">{p.id}</span>
            <span className={`st-badge${p.enabled ? "" : " st-off"}`}>
              {p.enabled ? "On" : "Off"}
            </span>
          </div>
          <p className="st-description">{p.description}</p>
          {Object.keys(p.config).length > 0 && (
            <dl>
              {Object.entries(p.config).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
      <OpenConfig onError={props.onError} />
    </section>
  );
}

function About({ settings, onError }: { settings: Settings; onError(err: unknown): void }) {
  return (
    <section>
      <Row label="Version" note="Which code the daemon runs">
        <code className="st-mono">{settings.code}</code>
      </Row>
      <Row label="Ivy's folder" note={settings.paths.home}>
        {inApp && (
          <button type="button" className="ghost" onClick={() => api.open("home").catch(onError)}>
            Show
          </button>
        )}
      </Row>
      <Row label="Settings file" note={settings.paths.config}>
        {inApp && (
          <button type="button" className="ghost" onClick={() => api.open("config").catch(onError)}>
            Open
          </button>
        )}
      </Row>
      {inApp && (
        <Row label="Logs" note="The app's and its daemon's">
          <button type="button" className="ghost" onClick={() => api.open("logs").catch(onError)}>
            Show
          </button>
        </Row>
      )}
    </section>
  );
}
