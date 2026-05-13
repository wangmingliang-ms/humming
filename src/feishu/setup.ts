import { execSync, spawn } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { saveConfig, loadSavedConfig } from "../config.js";

// ~/.lark-channel/config.json schema (matches lark-cli's lark-channel-bridge format)
interface LarkChannelConfig {
  accounts: { app: { id: string; secret: string; tenant?: string } };
}

function larkChannelConfigPath(): string {
  return path.join(os.homedir(), ".lark-channel", "config.json");
}

function readLarkChannelConfig(): { appId: string; appSecret: string } | null {
  try {
    const raw = fs.readFileSync(larkChannelConfigPath(), "utf-8");
    const cfg = JSON.parse(raw) as LarkChannelConfig;
    const { id, secret } = cfg.accounts?.app ?? {};
    if (id && secret) return { appId: id, appSecret: secret };
  } catch {
    // not present or malformed
  }
  return null;
}

/**
 * Resolve the lark-cli binary path.
 * Priority: local node_modules/.bin → global PATH
 * @larksuite/cli is a direct dependency so the local binary should always win.
 */
function resolveLarkCliBin(): string {
  const __dir = path.dirname(fileURLToPath(import.meta.url));
  // dist/src/feishu/ → project root is 3 levels up
  const projectRoot = path.resolve(__dir, "..", "..", "..");
  const localBin = path.join(projectRoot, "node_modules", ".bin", "lark-cli");
  try {
    execSync(`"${localBin}" --version`, { stdio: "ignore" });
    return localBin;
  } catch {
    // fall back to global
    return "lark-cli";
  }
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (a) => resolve(a.trim())));
}

async function runLarkCliSetup(log: (msg: string) => void): Promise<boolean> {
  const bin = resolveLarkCliBin();
  log(`Running: ${bin} config init --new`);
  log("A browser window will open — follow the prompts to create your Feishu app.\n");

  const initOk = await new Promise<boolean>((resolve) => {
    const proc = spawn(bin, ["config", "init", "--new"], { stdio: "inherit", shell: true });
    proc.on("close", (code) => resolve(code === 0));
  });
  if (!initOk) return false;

  log(`\nRunning: ${bin} config bind --source lark-channel`);
  log("This writes your App ID and Secret to ~/.lark-channel/config.json\n");

  const bindOk = await new Promise<boolean>((resolve) => {
    const proc = spawn(bin, ["config", "bind", "--source", "lark-channel"], {
      stdio: "inherit",
      shell: true,
    });
    proc.on("close", (code) => resolve(code === 0));
  });
  return bindOk;
}

export async function runSetup(
  storageDir: string,
  log: (msg: string) => void = console.log,
): Promise<{ appId: string; appSecret: string }> {
  // 1. Check ~/.lark-channel/config.json first (lark-cli native format)
  const larkChannel = readLarkChannelConfig();
  if (larkChannel) {
    log(`✓ Found existing config in ~/.lark-channel/config.json (App ID: ${larkChannel.appId})`);
    saveConfig(storageDir, { feishu: larkChannel });
    return larkChannel;
  }

  // 2. Check our own saved config
  const saved = loadSavedConfig(storageDir);
  if (saved?.feishu?.appId && saved?.feishu?.appSecret) {
    log(`✓ Found existing config in ~/.feishu-acp/config.json (App ID: ${saved.feishu.appId})`);
    return { appId: saved.feishu.appId, appSecret: saved.feishu.appSecret };
  }

  console.log(`
┌─────────────────────────────────────────┐
│         feishu-acp first-time setup     │
└─────────────────────────────────────────┘
`);

  // 3. Try lark-cli automated flow
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const useLarkCli = await prompt(
      rl,
      "Use lark-cli to auto-create a Feishu app? (recommended) [Y/n]: ",
    );

    if (useLarkCli.toLowerCase() !== "n") {
      const success = await runLarkCliSetup(log);

      if (success) {
        const creds = readLarkChannelConfig();
        if (creds) {
          log(`\n✓ Setup complete! App ID: ${creds.appId}`);
          saveConfig(storageDir, { feishu: creds });
          return creds;
        }
        log("⚠ lark-cli setup completed but config not found — falling back to manual entry.");
      } else {
        log("⚠ lark-cli setup failed — falling back to manual entry.");
      }
    }

    // 4. Manual fallback
    console.log(`
Manual setup:
  1. Go to https://open.feishu.cn/app → Create self-built app
  2. Add Bot capability
  3. Add permissions: im:message, im:message:send_as_bot
  4. Subscribe event: im.message.receive_v1  (use long connection)
  5. Publish the app
`);
    const appId = await prompt(rl, "App ID: ");
    const appSecret = await prompt(rl, "App Secret: ");

    if (!appId || !appSecret) throw new Error("App ID and App Secret are required");

    saveConfig(storageDir, { feishu: { appId, appSecret } });
    log(`\n✓ Config saved to ${storageDir}/config.json`);
    return { appId, appSecret };
  } finally {
    rl.close();
  }
}
