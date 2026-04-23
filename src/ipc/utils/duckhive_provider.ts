/**
 * DuckHive Provider for dyad
 *
 * Integrates DuckHive as a backend AI provider. DuckHive supports
 * 200+ models via OpenAI-compatible API.
 *
 * This provider auto-spawns a local DuckHive API server when needed.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import log from "electron-log";

const logger = log.scope("duckhive_provider");

// DuckHive API server configuration
const DUCKHIVE_API_HOST = process.env.DUCKHIVE_API_HOST || "localhost";
const DUCKHIVE_API_PORT = process.env.DUCKHIVE_API_PORT || "8080";
const DUCKHIVE_API_BASE = `http://${DUCKHIVE_API_HOST}:${DUCKHIVE_API_PORT}/v1`;

// Track server state
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let serverStartPromise: Promise<void> | null = null;
let serverReady = false;

/**
 * Check if DuckHive API server is running
 */
async function isServerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${DUCKHIVE_API_BASE}/models`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Start DuckHive API server as subprocess
 */
function startServerProcess(): ChildProcessWithoutNullStreams {
  logger.info("Starting DuckHive API server subprocess...");

  const duckhiveBin = process.env.DUCKHIVE_BIN || "duckhive";

  const child = spawn(duckhiveBin, ["api-server", "--port", DUCKHIVE_API_PORT], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Disable TUI auto-launch to ensure API mode
      DYAD_TUI_AUTO_LAUNCH: "false",
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    logger.info(`DuckHive API: ${output.trim()}`);
  });

  child.stderr?.on("data", (data: Buffer) => {
    const output = data.toString();
    // Filter out common non-error messages
    if (!output.includes("debug") && !output.includes("INFO")) {
      logger.warn(`DuckHive API stderr: ${output.trim()}`);
    }
  });

  child.on("error", (err) => {
    logger.error(`DuckHive server error: ${err.message}`);
    serverProcess = null;
    serverReady = false;
  });

  child.on("exit", (code) => {
    logger.info(`DuckHive server exited with code ${code}`);
    serverProcess = null;
    serverReady = false;
  });

  return child;
}

/**
 * Wait for server to be ready by polling the health endpoint
 */
async function waitForServerReady(timeoutMs = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await isServerRunning()) {
      serverReady = true;
      logger.info("DuckHive API server is ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("DuckHive server startup timeout");
}

/**
 * Ensure DuckHive server is running, spawn if needed
 */
export async function ensureDuckHiveServerRunning(): Promise<void> {
  // Check if already running
  if (serverReady && serverProcess) {
    return;
  }

  // If already starting, wait for it
  if (serverStartPromise) {
    return serverStartPromise;
  }

  // Check if server is already running (another instance)
  if (await isServerRunning()) {
    serverReady = true;
    return;
  }

  // Start the server
  serverStartPromise = (async () => {
    serverProcess = startServerProcess();
    await waitForServerReady();
    serverStartPromise = null;
  })();

  return serverStartPromise;
}

/**
 * Create a DuckHive provider that auto-spawns the API server if needed.
 *
 * DuckHive supports 200+ models via OpenAI-compatible API.
 */
export function createDuckHiveProvider(options?: {
  baseUrl?: string;
  apiKey?: string;
}) {
  const baseURL =
    options?.baseUrl || `http://${DUCKHIVE_API_HOST}:${DUCKHIVE_API_PORT}/v1`;

  logger.info(`Creating DuckHive provider with baseURL: ${baseURL}`);

  return createOpenAICompatible({
    name: "duckhive",
    baseURL,
    apiKey: options?.apiKey || "duckhive-api-key",
  });
}

/**
 * Get the DuckHive provider with auto-server-start.
 * Use this when you need to ensure the server is running before creating a model.
 */
export async function getDuckHiveProvider(options?: {
  baseUrl?: string;
  apiKey?: string;
}) {
  await ensureDuckHiveServerRunning();
  return createDuckHiveProvider(options);
}

/**
 * Stop the DuckHive server if it's running
 */
export function stopDuckHiveServer(): void {
  if (serverProcess) {
    logger.info("Stopping DuckHive API server");
    serverProcess.kill();
    serverProcess = null;
    serverReady = false;
    serverStartPromise = null;
  }
}

/**
 * Get server status for debugging
 */
export function getDuckHiveServerStatus(): {
  running: boolean;
  pid: number | null;
} {
  return {
    running: serverReady,
    pid: serverProcess?.pid ?? null,
  };
}