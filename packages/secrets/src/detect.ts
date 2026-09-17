// Vault detection — Plan §11, ADR-006. Pick the strongest complete vault for the
// current host: linux+libsecret where available; the encrypted-file vault as the
// always-works fallback. DarwinSecurityVault stays available for explicit read use
// but is not auto-selected (its store() fails closed by design — see adapters.ts).
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DarwinSecurityVault,
  EncryptedFileVault,
  LinuxSecretToolVault,
  realVaultExec,
  type VaultExec,
} from "./adapters.ts";
import type { SecretVault } from "./index.ts";

export interface VaultSelection {
  readonly kind: "linux-secret-tool" | "encrypted-file";
  readonly vault: SecretVault;
  readonly detail: string;
}

/** Where fallback state lives: XDG on linux/darwin, AppData on win32. */
export function defaultConfigDir(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return join(env["APPDATA"] ?? join(home, "AppData", "Roaming"), "aice");
  }
  const xdg = env["XDG_CONFIG_HOME"];
  if (typeof xdg === "string" && xdg !== "") return join(xdg, "aice");
  if (platform === "darwin") return join(home, "Library", "Application Support", "aice");
  return join(home, ".config", "aice");
}

/**
 * Complete-vault selection. Uses the real exec by default; tests inject a fake.
 * Never logs refs/values — `detail` is a residence description for operators.
 */
export async function detectVault(
  opts: {
    platform?: string;
    exec?: VaultExec;
    configDir?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<VaultSelection> {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? realVaultExec;
  if (platform === "linux" && (await LinuxSecretToolVault.isAvailable(exec))) {
    return Object.freeze({
      kind: "linux-secret-tool",
      vault: new LinuxSecretToolVault(exec),
      detail: "OS keyring (libsecret secret-tool)",
    });
  }
  if (platform === "darwin") {
    // Probe only for the detail message; selection stays the write-capable fallback.
    const hasSecurity = await DarwinSecurityVault.isAvailable(exec);
    const file = new EncryptedFileVault(opts.configDir ?? defaultConfigDir(platform, opts.env));
    return Object.freeze({
      kind: "encrypted-file",
      vault: file,
      detail: hasSecurity
        ? "encrypted-file vault (Keychain available for read-only migrated items)"
        : "encrypted-file vault (OS `security` tool unavailable)",
    });
  }
  return Object.freeze({
    kind: "encrypted-file",
    vault: new EncryptedFileVault(opts.configDir ?? defaultConfigDir(platform, opts.env)),
    detail:
      platform === "linux"
        ? "encrypted-file vault (secret-tool not found — install libsecret for OS keyring)"
        : "encrypted-file vault (OS keychain adapter unavailable on this platform)",
  });
}
