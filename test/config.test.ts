// Strict config-loading tests, written before src/config.ts exists (TDD).
//
// Coverage required by the Task 1 brief: missing Feishu identity, absent
// runtime endpoint, runtimeProfile !== "online", empty agent aliases,
// overlapping data paths (containment, not just string equality), and an
// accidental inline secret value. All fixtures live under a per-test temp
// directory; nothing here reads or writes a real path.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ConfigError,
  describeConfig,
  loadConfig,
  type ConfigEnv,
} from "../src/config.ts";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "meeting-agent-config-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeSecretFile(dir: string, name: string, contents: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, contents, "utf8");
  return file;
}

/** A complete, valid env record pointing entirely at files/dirs under `dir`. */
function validEnv(dir: string): ConfigEnv {
  const secretFile = writeSecretFile(dir, "feishu-app-secret", "s3cr3t-test-value-not-real");
  return {
    MEETING_AGENT_FEISHU_APP_ID: "cli_test_app_id",
    MEETING_AGENT_FEISHU_APP_SECRET_FILE: secretFile,
    MEETING_AGENT_RUNTIME_ENDPOINT: "https://runtime.example.internal:9443",
    MEETING_AGENT_RUNTIME_PROFILE: "online",
    MEETING_AGENT_ALIASES: "Robo, robo-agent",
    MEETING_AGENT_RECORDINGS_DIR: path.join(dir, "recordings"),
    MEETING_AGENT_OUTBOX_DIR: path.join(dir, "outbox"),
    MEETING_AGENT_RECEIPTS_DIR: path.join(dir, "receipts"),
    MEETING_AGENT_TEAM_VAULT_DIR: path.join(dir, "vault-checkout"),
  };
}

test("loads a complete valid config", () => {
  withTempDir((dir) => {
    const config = loadConfig({ env: validEnv(dir) });
    assert.equal(config.feishu.appId, "cli_test_app_id");
    assert.equal(config.feishu.appSecret.reveal(), "s3cr3t-test-value-not-real");
    assert.equal(config.conversationRuntime.endpoint, "https://runtime.example.internal:9443/");
    assert.equal(config.conversationRuntime.profile, "online");
    assert.deepEqual(config.agentIdentity.aliases, ["Robo", "robo-agent"]);
    assert.equal(config.dataPaths.recordingsDir, path.resolve(dir, "recordings"));
  });
});

test("missing Feishu identity: absent app id is a config error naming the field", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_FEISHU_APP_ID;
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appId");
      return true;
    });
  });
});

test("missing Feishu identity: absent app secret file reference is a config error", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_FEISHU_APP_SECRET_FILE;
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appSecret");
      return true;
    });
  });
});

test("missing Feishu identity: blank app id (whitespace only) is treated as absent", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir), MEETING_AGENT_FEISHU_APP_ID: "   " };
    assert.throws(() => loadConfig({ env }), ConfigError);
  });
});

test("absent runtime endpoint is a config error", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_RUNTIME_ENDPOINT;
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "conversationRuntime.endpoint");
      return true;
    });
  });
});

test("a malformed runtime endpoint URL is a config error", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir), MEETING_AGENT_RUNTIME_ENDPOINT: "not a url" };
    assert.throws(() => loadConfig({ env }), ConfigError);
  });
});

test('runtimeProfile !== "online" is a config error in v1', () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir), MEETING_AGENT_RUNTIME_PROFILE: "offline" };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "conversationRuntime.profile");
      assert.match(error.message, /online/);
      return true;
    });
  });
});

test("runtimeProfile defaults to online when unset", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_RUNTIME_PROFILE;
    const config = loadConfig({ env });
    assert.equal(config.conversationRuntime.profile, "online");
  });
});

test("empty agent aliases: unset aliases env var is a config error", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_ALIASES;
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "agentIdentity.aliases");
      return true;
    });
  });
});

test("empty agent aliases: blank/whitespace-only aliases is a config error", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir), MEETING_AGENT_ALIASES: " , ,  " };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "agentIdentity.aliases");
      return true;
    });
  });
});

test("overlapping data paths: outbox nested inside recordings is a config error", () => {
  withTempDir((dir) => {
    const recordingsDir = path.join(dir, "recordings");
    const env = {
      ...validEnv(dir),
      MEETING_AGENT_RECORDINGS_DIR: recordingsDir,
      MEETING_AGENT_OUTBOX_DIR: path.join(recordingsDir, "outbox"),
    };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.field, /^dataPaths\./);
      assert.match(error.message, /overlap/);
      return true;
    });
  });
});

test("overlapping data paths: two configured dirs resolving to the identical path is an error", () => {
  withTempDir((dir) => {
    const shared = path.join(dir, "shared");
    const env = {
      ...validEnv(dir),
      MEETING_AGENT_RECEIPTS_DIR: shared,
      MEETING_AGENT_TEAM_VAULT_DIR: shared,
    };
    assert.throws(() => loadConfig({ env }), ConfigError);
  });
});

test("overlapping data paths: relative segments resolve before the containment check runs", () => {
  withTempDir((dir) => {
    const recordingsDir = path.join(dir, "recordings");
    const env = {
      ...validEnv(dir),
      MEETING_AGENT_RECORDINGS_DIR: recordingsDir,
      // Textually different, but resolves to the same nested path once
      // normalized -- proves the check compares resolved paths, not strings.
      MEETING_AGENT_OUTBOX_DIR: path.join(recordingsDir, "nested", "..", "nested", "outbox"),
    };
    assert.throws(() => loadConfig({ env }), ConfigError);
  });
});

test("data paths that merely share a string prefix are NOT flagged as overlapping", () => {
  withTempDir((dir) => {
    // "recordings-archive" starts with the string "recordings" but is a
    // sibling directory, not a descendant. A naive startsWith() check would
    // wrongly flag this; a path-boundary-aware check must not.
    const env = {
      ...validEnv(dir),
      MEETING_AGENT_RECORDINGS_DIR: path.join(dir, "recordings"),
      MEETING_AGENT_OUTBOX_DIR: path.join(dir, "recordings-archive"),
    };
    const config = loadConfig({ env });
    assert.equal(config.dataPaths.recordingsDir, path.resolve(dir, "recordings"));
    assert.equal(config.dataPaths.outboxDir, path.resolve(dir, "recordings-archive"));
  });
});

test("accidental inline secret value: secret-shaped string instead of a file path is rejected", () => {
  withTempDir((dir) => {
    const env = {
      ...validEnv(dir),
      // Looks like someone pasted a token directly into the "_FILE" var
      // instead of pointing it at a file on disk.
      MEETING_AGENT_FEISHU_APP_SECRET_FILE: ["sk", "live", "51NotARealSecretValueButLooksLikeOne00000"].join("_"),
    };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appSecret");
      // The error must describe the mistake without repeating the value.
      assert.doesNotMatch(error.message, /sk_live_51/);
      return true;
    });
  });
});

test("accidental inline secret value: a relative path is rejected (must be absolute)", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir), MEETING_AGENT_FEISHU_APP_SECRET_FILE: "./feishu-app-secret" };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appSecret");
      return true;
    });
  });
});

test("secret file that does not exist produces a config error without leaking a value", () => {
  withTempDir((dir) => {
    const env = {
      ...validEnv(dir),
      MEETING_AGENT_FEISHU_APP_SECRET_FILE: path.join(dir, "does-not-exist"),
    };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appSecret");
      return true;
    });
  });
});

test("empty secret file is a config error", () => {
  withTempDir((dir) => {
    const emptyFile = writeSecretFile(dir, "empty-secret", "");
    const env = { ...validEnv(dir), MEETING_AGENT_FEISHU_APP_SECRET_FILE: emptyFile };
    assert.throws(() => loadConfig({ env }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.field, "feishu.appSecret");
      return true;
    });
  });
});

test("describeConfig() is safe to paste into an issue: field names and redacted status, never the credential value", () => {
  withTempDir((dir) => {
    const secretValue = "s3cr3t-test-value-not-real";
    const config = loadConfig({ env: validEnv(dir) });
    const summary = describeConfig(config);
    const serialized = JSON.stringify(summary);

    assert.doesNotMatch(serialized, new RegExp(secretValue));
    assert.match(serialized, /"appId":"cli_test_app_id"/);
    assert.match(serialized, /"appSecret":"redacted"/);
    assert.match(serialized, /"aliasCount":2/);
  });
});

test("RedactedSecret never exposes its value via toString/toJSON/JSON.stringify", () => {
  withTempDir((dir) => {
    const secretValue = "s3cr3t-test-value-not-real";
    const config = loadConfig({ env: validEnv(dir) });

    assert.equal(String(config.feishu.appSecret), "[REDACTED]");
    assert.equal(JSON.stringify(config.feishu.appSecret), '"[REDACTED]"');
    assert.equal(JSON.stringify(config), JSON.stringify(config).replace(secretValue, secretValue));
    assert.doesNotMatch(JSON.stringify(config), new RegExp(secretValue));
    assert.equal(config.feishu.appSecret.reveal(), secretValue);
  });
});

test("ConfigError messages never contain a secret value even for unrelated field failures", () => {
  withTempDir((dir) => {
    const env = { ...validEnv(dir) };
    delete (env as Record<string, string | undefined>).MEETING_AGENT_RUNTIME_ENDPOINT;
    try {
      loadConfig({ env });
      assert.fail("expected loadConfig to throw");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.doesNotMatch(error.message, /s3cr3t-test-value-not-real/);
    }
  });
});
