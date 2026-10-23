// API keys in the macOS Keychain (DESIGN.md §5.2): a provider without `api_key` in
// config.toml has its key here, as a generic password of service "Ivy" ("Ivy Dev" in
// development) and account the provider's name. Read and written through /usr/bin/security,
// whose signature never changes, so a rebuilt `ivy` is never asked for access again (the
// Keychain asks per program). Elsewhere there is no store, and keys stay in config.toml.

import { RELEASE } from "./config.ts";

/** Where keys are kept apart from config.toml. */
export interface KeyStore {
  /** Whether keys can be kept here at all. */
  readonly available: boolean;
  get(provider: string): string | undefined;
  set(provider: string, key: string): void;
  /** Whether there was one. */
  remove(provider: string): boolean;
}

/** Development keeps keys of its own, so editing them there never touches the user's (§7). */
const SERVICE = RELEASE ? "Ivy" : "Ivy Dev";
const SECURITY = "/usr/bin/security";
/** `security`'s exit status for an item that isn't there. */
const NOT_FOUND = 44;

function run(args: string[], stdin?: string): { code: number; out: string; err: string } {
  const proc = Bun.spawnSync([SECURITY, ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString().trim(),
  };
}

/** The login Keychain, on macOS. */
export class MacKeychain implements KeyStore {
  readonly available = true;

  get(provider: string): string | undefined {
    const r = run(["find-generic-password", "-s", SERVICE, "-a", provider, "-w"]);
    if (r.code === NOT_FOUND) return undefined;
    if (r.code !== 0) throw new Error(`Keychain: ${r.err || `security exited ${r.code}`}`);
    return r.out.replace(/\n$/, "") || undefined;
  }

  set(provider: string, key: string): void {
    // -U replaces one there already; -w last with no value reads the password from stdin,
    // so the key never shows in the process list.
    const r = run(
      ["add-generic-password", "-U", "-s", SERVICE, "-a", provider, "-l", `Ivy: ${provider}`, "-w"],
      `${key}\n${key}\n`,
    );
    if (r.code !== 0) throw new Error(`Keychain: ${r.err || `security exited ${r.code}`}`);
  }

  remove(provider: string): boolean {
    const r = run(["delete-generic-password", "-s", SERVICE, "-a", provider]);
    if (r.code === NOT_FOUND) return false;
    if (r.code !== 0) throw new Error(`Keychain: ${r.err || `security exited ${r.code}`}`);
    return true;
  }
}

/** No store: keys stay in config.toml. */
export const noKeyStore: KeyStore = {
  available: false,
  get: () => undefined,
  set: () => {
    throw new Error("No keychain here: set api_key in config.toml");
  },
  remove: () => false,
};

/** Keys kept in memory (tests). */
export class MemoryKeyStore implements KeyStore {
  readonly available = true;
  readonly keys = new Map<string, string>();
  get = (provider: string) => this.keys.get(provider);
  set = (provider: string, key: string) => void this.keys.set(provider, key);
  remove = (provider: string) => this.keys.delete(provider);
}

/** The store for this machine. */
export function defaultKeyStore(): KeyStore {
  return process.platform === "darwin" ? new MacKeychain() : noKeyStore;
}
