// Unit: OS vault adapters + encrypted fallback. Rule under test (T5): secret values
// flow via stdin/files only — never argv. OS adapters run against mocked exec; the
// encrypted vault runs real AES-GCM round-trips on disk.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EncryptedFileVault,
  LinuxSecretToolVault,
  DarwinSecurityVault,
  detectVault,
  defaultConfigDir,
  secretRef,
  secretValue,
  VaultError,
} from "../../../packages/secrets/src/index.ts";

const REF = secretRef("vault://providers/p1/key");
const VALUE = secretValue("sk-TESTONLY-vault-0123456789abcdef");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aice-vault-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("EncryptedFileVault", () => {
  it("round-trips store/load/describe/has/rotate/delete", async () => {
    const vault = new EncryptedFileVault(dir);
    assert.equal(await vault.has(REF), false);
    await vault.store(REF, VALUE);
    assert.equal(await vault.has(REF), true);
    assert.equal(String(await vault.load(REF)), String(VALUE));
    const meta = await vault.describe(REF);
    assert.equal(meta.last4, "cdef");
    assert.notEqual(meta.createdAt, "");
    const other = secretValue("sk-TESTONLY-vault-rotated00000099999999");
    await vault.rotate(REF, other);
    assert.equal(String(await vault.load(REF)), String(other));
    assert.equal((await vault.describe(REF)).last4, "9999");
    await vault.delete(REF);
    assert.equal(await vault.has(REF), false);
    await assert.rejects(vault.load(REF), (e) => e instanceof VaultError && e.code === "NOT_FOUND");
  });

  it("never stores plaintext on disk (only AeS ciphertext + by-design last4 metadata)", async () => {
    const vault = new EncryptedFileVault(dir);
    await vault.store(REF, VALUE);
    await vault.store(secretRef("vault://providers/p1/other"), secretValue("ak-another-value-zzzz-yyyy-xxxx"));
    const raw = readFileSync(join(dir, "vault.enc.json"), "utf8");
    assert.ok(!raw.includes("sk-vault-unit"));
    assert.ok(!raw.includes("ak-another-value"));
    assert.ok(!raw.includes(String(VALUE)));
    // last4 is intentional interface metadata — present, but nothing beyond it:
    assert.ok(raw.includes("cdef"));
  });

  it("fails closed when the master key is wrong (never returns garbage)", async () => {
    const vaultDir = join(dir, "a");
    const v1 = new EncryptedFileVault(vaultDir);
    await v1.store(REF, VALUE);
    // a second vault instance with a DIFFERENT key over the same data dir
    const otherDir = join(dir, "b");
    new EncryptedFileVault(otherDir);
    const foreignKey = readFileSync(join(otherDir, "vault.key"));
    writeFileSync(join(vaultDir, "vault.key"), foreignKey, { mode: 0o600 });
    // new instance loads the foreign key
    const tampered = new EncryptedFileVault(vaultDir);
    await assert.rejects(
      tampered.load(REF),
      (e) => e instanceof VaultError && e.code === "BACKEND_UNAVAILABLE",
    );
  });

  it("fails closed on loose key-file permissions and on vault-without-key", async () => {
    const v1 = new EncryptedFileVault(join(dir, "perm"));
    await v1.store(REF, VALUE);
    chmodSync(join(dir, "perm", "vault.key"), 0o644);
    assert.throws(
      () => new EncryptedFileVault(join(dir, "perm")),
      (e) => e instanceof VaultError && e.code === "BACKEND_UNAVAILABLE" && /chmod 600/.test(e.message),
    );
    // encrypted vault exists but key is gone → refuse to re-encrypt over it
    const d2 = join(dir, "lostkey");
    new EncryptedFileVault(d2);
    await new EncryptedFileVault(d2).store(REF, VALUE);
    rmSync(join(d2, "vault.key"));
    assert.throws(
      () => new EncryptedFileVault(d2),
      (e) => e instanceof VaultError && e.code === "BACKEND_UNAVAILABLE" && /master key/.test(e.message),
    );
  });

  it("fails closed on corrupted vault JSON", async () => {
    const vault = new EncryptedFileVault(dir);
    await vault.store(REF, VALUE);
    writeFileSync(join(dir, "vault.enc.json"), "{not json");
    await assert.rejects(vault.load(REF), (e) => e instanceof VaultError && e.code === "BACKEND_UNAVAILABLE");
    await assert.rejects(vault.has(REF), (e) => e instanceof VaultError && e.code === "BACKEND_UNAVAILABLE");
  });
});

describe("OS adapters enforce the no-secret-in-argv rule", () => {
  function fakeExec(record) {
    return async (cmd, args, opts = {}) => {
      record.push({ cmd, args: [...args], input: opts.input });
      const key = `${cmd} ${args.join(" ")}`;
      if (key.includes("lookup")) {
        if (record.lookupMiss) throw new VaultError("BACKEND_UNAVAILABLE", "miss");
        return { stdout: `${String(VALUE)}\n`, stderr: "" };
      }
      return { stdout: "0.9.4\n", stderr: "" };
    };
  }

  it("linux vault: value is piped via stdin; argv carries service/ref only", async () => {
    const record = [];
    const exec = fakeExec(record);
    const vault = new LinuxSecretToolVault(exec);
    await vault.store(REF, VALUE);
    const storeCall = record.find((c) => c.args[0] === "store");
    assert.ok(storeCall, "store call recorded");
    assert.ok(storeCall.args.every((a) => !a.includes(String(VALUE))), "no secret in argv");
    assert.equal(storeCall.input.trimEnd(), String(VALUE));
    const loaded = await vault.load(REF,);
    assert.equal(String(loaded), String(VALUE));
  });

  it("linux vault: lookup miss → NOT_FOUND", async () => {
    const record = [];
    const exec = fakeExec(record);
    record.lookupMiss = true;
    const vault = new LinuxSecretToolVault(exec);
    await assert.rejects(vault.load(REF), (e) => e instanceof VaultError && e.code === "NOT_FOUND");
  });

  it("darwin vault: store() fails closed (argv-exposure), load() works", async () => {
    const record = [];
    const exec = async (cmd, args) => {
      record.push({ cmd, args: [...args] });
      if (args.includes("-w")) return { stdout: `${String(VALUE)}\n`, stderr: "" };
      return { stdout: "", stderr: "" };
    };
    const vault = new DarwinSecurityVault(exec);
    await assert.rejects(
      vault.store(REF, VALUE),
      (e) =>
        e instanceof VaultError &&
        e.code === "BACKEND_UNAVAILABLE" &&
        /T5/.test(e.message),
    );
    assert.ok(record.every((c) => c.args.every((a) => !a.includes(String(VALUE)))));
    assert.equal(String(await vault.load(REF)), String(VALUE));
  });
});

describe("detectVault", () => {
  it("prefers secret-tool on linux when available; falls back to encrypted file", async () => {
    const availableExec = async () => ({ stdout: "", stderr: "" });
    const sel1 = await detectVault({ platform: "linux", exec: availableExec, configDir: join(dir, "cfg1") });
    assert.equal(sel1.kind, "linux-secret-tool");
    const missingExec = async () => {
      throw new VaultError("BACKEND_UNAVAILABLE", "ENOENT");
    };
    const sel2 = await detectVault({ platform: "linux", exec: missingExec, configDir: join(dir, "cfg2") });
    assert.equal(sel2.kind, "encrypted-file");
    assert.match(sel2.detail, /secret-tool/);
    // fallback vault is fully functional out of the box
    await sel2.vault.store(REF, VALUE);
    assert.equal(String(await sel2.vault.load(REF)), String(VALUE));
  });

  it("darwin selection is the write-capable fallback with an informative detail", async () => {
    const sel = await detectVault({
      platform: "darwin",
      exec: async () => ({ stdout: "", stderr: "" }),
      configDir: join(dir, "cfg3"),
    });
    assert.equal(sel.kind, "encrypted-file");
    assert.match(sel.detail, /encrypted-file/);
  });

  it("config dir honors XDG on linux and AppData on windows", () => {
    assert.equal(
      defaultConfigDir("linux", { XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
      join("/xdg", "aice"),
    );
    assert.equal(defaultConfigDir("linux", {}, "/home/u"), join("/home/u", ".config", "aice"));
    assert.equal(
      defaultConfigDir("win32", { APPDATA: "C:\\App" }, "C:\\u"),
      join("C:\\App", "aice"),
    );
  });
});
