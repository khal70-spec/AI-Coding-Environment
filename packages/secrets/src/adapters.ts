// OS vault adapters + encrypted-file fallback — Plan §11, ADR-006 (Phase 2 P2.4).
// HARD RULES (T5): a secret value NEVER appears in argv (process lists), stderr,
// or thrown errors. `secret-tool` receives values on stdin only. macOS `security
// add-generic-password -w <value>` is structurally unsafe (argv), so the Darwin
// adapter is read-enabled and store() fails closed with a remediation — the
// EncryptedFileVault fallback (AES-256-GCM) covers writes on all platforms.
// Every adapter keeps the handle-only contract: values cross the membrane in
// store()/load() only.
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  openSync,
  closeSync,
  writeSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import type { SecretMeta, SecretRef, SecretValue, SecretVault } from "./index.ts";
import { last4Of, secretRef, secretValue, VaultError } from "./index.ts";

/** Injectable command runner (argv-only binaries, never shell). */
export type VaultExec = (
  cmd: string,
  args: readonly string[],
  opts?: { input?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string }>;

/** spawn()-based runner: no shell, stdin-capable, kill on timeout. */
export const realVaultExec: VaultExec = async (cmd, args, opts = {}) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new VaultError("BACKEND_UNAVAILABLE", "vault command timed out"));
    }, opts.timeoutMs ?? 5_000);
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => err.push(d));
    child.on("error", (e: Error) => {
      clearTimeout(timer);
      // ENOENT etc. — binary missing; no secret can be present here.
      reject(new VaultError("BACKEND_UNAVAILABLE", `vault command failed: ${e.message.slice(0, 160)}`));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      const stderrText = Buffer.concat(err).toString("utf8");
      if (code === 0) {
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: stderrText });
      } else {
        // stderr may reference refs/paths; our values go via stdin only (never argv).
        reject(
          new VaultError(
            "BACKEND_UNAVAILABLE",
            `vault command exited ${code}: ${stderrText.slice(0, 160)}`,
          ),
        );
      }
    });
    if (opts.input !== undefined) {
      child.stdin.on("error", () => {}); // EPIPE if the child exits early
      child.stdin.write(opts.input);
    }
    child.stdin.end();
  });
};

function refToServiceName(ref: SecretRef): string {
  const raw: string = ref;
  // vault://group/leaf → "aice:group/leaf" (no values, refs only)
  return `aice:${raw.slice("vault://".length)}`;
}

/* ------------------------------ linux: secret-tool ------------------------------ */

export class LinuxSecretToolVault implements SecretVault {
  private exec: VaultExec;
  constructor(exec: VaultExec = realVaultExec) {
    this.exec = exec;
  }

  static async isAvailable(exec: VaultExec = realVaultExec): Promise<boolean> {
    try {
      await exec("secret-tool", ["--version"], { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  private attrs(ref: SecretRef): string {
    return refToServiceName(ref);
  }

  async store(ref: SecretRef, value: SecretValue): Promise<void> {
    // Value goes via STDIN ONLY — argv would be visible in `ps` (T5).
    await this.exec(
      "secret-tool",
      ["store", "--label=aice credential", "service", "aice", "ref", this.attrs(ref)],
      { input: `${value}\n` },
    );
  }

  async load(ref: SecretRef): Promise<SecretValue> {
    let out: { stdout: string };
    try {
      out = await this.exec("secret-tool", ["lookup", "service", "aice", "ref", this.attrs(ref)]);
    } catch {
      // secret-tool exits non-zero on a miss; detectVault() probed liveness already,
      // so by the time a load happens, a failure here means "not stored".
      throw new VaultError("NOT_FOUND", "no secret for ref");
    }
    // secret-tool prints an empty line for a miss on some builds; normalize.
    let value = out.stdout;
    if (value.endsWith("\n")) value = value.slice(0, -1);
    if (value.endsWith("\r")) value = value.slice(0, -1);
    if (value === "") throw new VaultError("NOT_FOUND", "no secret for ref");
    return secretValue(value);
  }

  async rotate(ref: SecretRef, value: SecretValue): Promise<void> {
    if (!(await this.has(ref))) throw new VaultError("NOT_FOUND", "no secret for ref");
    await this.store(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    try {
      await this.exec("secret-tool", ["clear", "service", "aice", "ref", this.attrs(ref)]);
    } catch {
      // delete is best-effort idempotent
    }
  }

  async describe(ref: SecretRef): Promise<SecretMeta> {
    const value = await this.load(ref); // also proves existence
    return { ref, last4: last4Of(value), createdAt: "", updatedAt: "" }; // secret-tool keeps no timestamps
  }

  async has(ref: SecretRef): Promise<boolean> {
    try {
      await this.load(ref);
      return true;
    } catch {
      return false;
    }
  }
}

/* ------------------------------ darwin: security CLI ---------------------------- */

export class DarwinSecurityVault implements SecretVault {
  private exec: VaultExec;
  constructor(exec: VaultExec = realVaultExec) {
    this.exec = exec;
  }

  static async isAvailable(exec: VaultExec = realVaultExec): Promise<boolean> {
    try {
      await exec("security", ["help"], { timeoutMs: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  async store(ref: SecretRef, _value: SecretValue): Promise<void> {
    // `security add-generic-password -w <value>` would place the SECRET IN ARGV — a
    // T5 violation. macOS writes are delegated to the encrypted-file fallback; reads
    // remain available for keys imported via Keychain Access.
    throw new VaultError(
      "BACKEND_UNAVAILABLE",
      `darwin store disabled (argv-exposure, T5) for ${String(ref)} — EncryptedFileVault handles writes`,
    );
  }

  async load(ref: SecretRef): Promise<SecretValue> {
    let out: { stdout: string };
    try {
      out = await this.exec("security", ["find-generic-password", "-s", refToServiceName(ref), "-w"]);
    } catch {
      throw new VaultError("NOT_FOUND", "no secret for ref");
    }
    let value = out.stdout.trimEnd();
    if (value === "") throw new VaultError("NOT_FOUND", "no secret for ref");
    return secretValue(value);
  }

  async rotate(ref: SecretRef, value: SecretValue): Promise<void> {
    // Same argv-exposure constraint as store(): fail closed with remediation.
    await this.store(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    try {
      await this.exec("security", ["delete-generic-password", "-s", refToServiceName(ref)]);
    } catch {
      // idempotent
    }
  }

  async describe(ref: SecretRef): Promise<SecretMeta> {
    const value = await this.load(ref);
    return { ref, last4: last4Of(value), createdAt: "", updatedAt: "" };
  }

  async has(ref: SecretRef): Promise<boolean> {
    try {
      await this.load(ref);
      return true;
    } catch {
      return false;
    }
  }
}

/* --------------------------- encrypted file fallback --------------------------- */

interface VaultEntryRecord {
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
  readonly last4: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface VaultFile {
  readonly version: 1;
  readonly entries: Record<string, VaultEntryRecord>;
}

function b64(buf: Buffer): string {
  return buf.toString("base64");
}
function unb64(s: string): Buffer {
  return Buffer.from(s, "base64");
}

/**
 * AES-256-GCM vault file + 0600 master key. Honest threat note (ADR-006): this
 * protects secrets at REST against other-file/DB exfil and casual readers; a local
 * attacker holding the user's credentials can read both key and vault — the OS
 * adapters exist for exactly that reason and are preferred when available.
 */
export class EncryptedFileVault implements SecretVault {
  readonly file: string;
  readonly keyFile: string;
  private key: Buffer;

  constructor(dir: string, opts: { file?: string; keyFile?: string } = {}) {
    this.file = opts.file ?? join(dir, "vault.enc.json");
    this.keyFile = opts.keyFile ?? join(dir, "vault.key");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort on platforms without POSIX modes
    }
    this.key = this.loadOrCreateKey();
  }

  private loadOrCreateKey(): Buffer {
    if (existsSync(this.keyFile)) {
      const st = statSync(this.keyFile);
      if (process.platform !== "win32") {
        // fail closed on loose perms — a world-readable master key is no key at all
        if ((st.mode & 0o777 & ~0o600) !== 0 || (st.mode & 0o600) !== 0o600) {
          throw new VaultError(
            "BACKEND_UNAVAILABLE",
            `vault key permissions too open (${(st.mode & 0o777).toString(8)}); run: chmod 600 ${this.keyFile}`,
          );
        }
      }
      const raw = readFileSync(this.keyFile);
      if (raw.length !== 32) {
        throw new VaultError("BACKEND_UNAVAILABLE", "vault key file is corrupt (32-byte key expected)");
      }
      return raw;
    }
    if (existsSync(this.file)) {
      // Encrypted vault without its key: never silently re-encrypt over old secrets.
      throw new VaultError(
        "BACKEND_UNAVAILABLE",
        `vault file exists but master key is missing: ${this.keyFile}`,
      );
    }
    const key = randomBytes(32);
    const fd = openSync(this.keyFile, "wx", 0o600); // create-exclusive, mode 0600
    try {
      writeSync(fd, key);
    } finally {
      closeSync(fd);
    }
    return key;
  }

  private readAll(): VaultFile {
    if (!existsSync(this.file)) return { version: 1, entries: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      throw new VaultError("BACKEND_UNAVAILABLE", "vault file is not parseable JSON — refusing to continue");
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { entries?: unknown }).entries !== "object"
    ) {
      throw new VaultError("BACKEND_UNAVAILABLE", "vault file has an unsupported shape");
    }
    return parsed as VaultFile;
  }

  private writeAll(data: VaultFile): void {
    const tmp = `${this.file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // POSIX-only tightening
    }
    renameSync(tmp, this.file);
  }

  private encrypt(ref: SecretRef, value: SecretValue): VaultEntryRecord {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(String(ref), "utf8")); // binds ciphertext → ref (no ref-swap)
    const ct = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { iv: b64(iv), tag: b64(tag), ct: b64(ct), last4: last4Of(value), createdAt: "", updatedAt: "" };
  }

  private decrypt(ref: SecretRef, entry: VaultEntryRecord): SecretValue {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, unb64(entry.iv));
      decipher.setAAD(Buffer.from(String(ref), "utf8"));
      decipher.setAuthTag(unb64(entry.tag));
      const pt = Buffer.concat([decipher.update(unb64(entry.ct)), decipher.final()]);
      const value = pt.toString("utf8");
      // last4 metadata integrity: refuse records whose tail doesn't match the value
      if (!timingSafeEqual(Buffer.from(entry.last4.slice(-4)), Buffer.from(last4Of(secretValue(value)).slice(-4)))) {
        throw new Error("metadata mismatch");
      }
      return secretValue(value);
    } catch {
      throw new VaultError(
        "BACKEND_UNAVAILABLE",
        "vault decryption failed (wrong key or corrupted entry)",
      );
    }
  }

  async store(ref: SecretRef, value: SecretValue): Promise<void> {
    const all = this.readAll();
    const now = new Date().toISOString();
    const prev = all.entries[String(ref)];
    const entry = this.encrypt(ref, value);
    all.entries[String(ref)] = {
      ...entry,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.writeAll(all);
  }

  async load(ref: SecretRef): Promise<SecretValue> {
    const all = this.readAll();
    const entry = all.entries[String(ref)];
    if (entry === undefined) throw new VaultError("NOT_FOUND", "no secret for ref");
    return this.decrypt(ref, entry);
  }

  async rotate(ref: SecretRef, value: SecretValue): Promise<void> {
    if (!(await this.has(ref))) throw new VaultError("NOT_FOUND", "no secret for ref");
    await this.store(ref, value);
  }

  async delete(ref: SecretRef): Promise<void> {
    const all = this.readAll();
    delete all.entries[String(ref)];
    this.writeAll(all);
  }

  async describe(ref: SecretRef): Promise<SecretMeta> {
    const all = this.readAll();
    const entry = all.entries[String(ref)];
    if (entry === undefined) throw new VaultError("NOT_FOUND", "no secret for ref");
    return {
      ref: secretRef(String(ref)),
      last4: entry.last4,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  async has(ref: SecretRef): Promise<boolean> {
    return this.readAll().entries[String(ref)] !== undefined;
  }
}
