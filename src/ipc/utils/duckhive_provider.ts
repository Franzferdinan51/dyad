/**
 * DuckHive Provider for dyad
 *
 * Integrates DuckHive as a backend AI provider. DuckHive supports
 * 200+ models via OpenAI-compatible API.
 *
 * This provider spawns a local DuckHive API server and connects to it
 * using the OpenAI-compatible interface.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import log from "electron-log";

const logger = log.scope("duckhive_provider");

// DuckHive API server configuration
const DUCKHIVE_API_HOST = process.env.DUCKHIVE_API_HOST || "localhost";
const DUCKHIVE_API_PORT = process.env.DUCKHIVE_API_PORT || "8080";

/**
 * Create a DuckHive provider that connects to DuckHive's API server.
 *
 * DuckHive must be running in API mode:
 *   duckhive api-server --port 8080
 *
 * Or it will auto-start when needed.
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
    apiKey: options?.apiKey || "duckhive-api-key", // DuckHive may not need a real key
  });
}

// Keep the subprocess-based provider as an alternative for when API server isn't available
export async function createDuckHiveSubprocessProvider(_modelId?: string) {
  const { spawn } = await import("child_process");

  // Spawn duckhive with API server mode
  const duckhiveProcess = spawn("duckhive", ["api-server", "--port", DUCKHIVE_API_PORT], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise<void>((resolve, reject) => {
    let ready = false;

    duckhiveProcess.stdout?.on("data", (data: Buffer) => {
      const output = data.toString();
      logger.info(`DuckHive: ${output}`);
      if (output.includes("running") || output.includes("listening")) {
        ready = true;
        resolve();
      }
    });

    duckhiveProcess.stderr?.on("data", (data: Buffer) => {
      logger.warn(`DuckHive stderr: ${data.toString()}`);
    });

    duckhiveProcess.on("error", reject);

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!ready) {
        duckhiveProcess.kill();
        reject(new Error("DuckHive startup timeout"));
      }
    }, 30000);
  });
}

export function stopDuckHiveServer(): void {
  // This would need to track the spawned process
  // For now, it's a placeholder
  logger.info("Stopping DuckHive server (placeholder)");
}
