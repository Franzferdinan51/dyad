/**
 * DuckHive gRPC Streaming Provider for dyad
 *
 * Provides full bidirectional streaming with tool-calling support.
 * This integrates with DuckHive's gRPC server for real-time agent interactions.
 *
 * DuckHive gRPC server provides:
 * - Bidirectional streaming (submitMessage returns async generator)
 * - Tool calls (canUseTool callback for permission prompts)
 * - Session persistence (cross-stream message accumulation)
 * - Multi-turn context (previousMessages accumulated)
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { randomUUID } from "crypto";
import log from "electron-log";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import path from "path";

const logger = log.scope("duckhive_grpc");

// gRPC server configuration
const DUCKHIVE_GRPC_HOST = process.env.DUCKHIVE_GRPC_HOST || "localhost";
const DUCKHIVE_GRPC_PORT = process.env.DUCKHIVE_GRPC_PORT || "50051";

// Proto path - in production would be bundled with dyad
function getProtoPath(): string {
  const home = process.env.HOME ?? "";
  return path.join(home, "Desktop/DuckHive/DuckHive/src/proto/openclaude.proto");
}

// Load proto and create gRPC client factory
interface GrpcClientFactory {
  AgentService: {
    Chat(): grpc.ClientDuplexStream<any, any>;
  };
}

let protoDescriptor: any = null;

function loadProto(): GrpcClientFactory {
  if (protoDescriptor) {
    return protoDescriptor.openclaude.v1;
  }

  const PROTO_PATH = getProtoPath();
  logger.info(`Loading DuckHive proto from: ${PROTO_PATH}`);

  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });

  protoDescriptor = grpc.loadPackageDefinition(packageDefinition);
  return protoDescriptor.openclaude.v1;
}

// Server state
let serverProcess: ChildProcessWithoutNullStreams | null = null;
let serverStartPromise: Promise<void> | null = null;
let serverReady = false;

/**
 * Check if DuckHive gRPC server is running
 */
async function isServerRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new grpc.Client(
      `${DUCKHIVE_GRPC_HOST}:${DUCKHIVE_GRPC_PORT}`,
      grpc.credentials.createInsecure(),
      {
        "grpc.initial_connection_timeout": 2000,
      }
    );

    client.waitForReady(Date.now() + 2000, (err) => {
      client.close();
      resolve(!err);
    });
  });
}

/**
 * Start DuckHive gRPC server subprocess
 */
function startServerProcess(): ChildProcessWithoutNullStreams {
  logger.info("Starting DuckHive gRPC server subprocess...");

  const duckhiveBin = process.env.DUCKHIVE_BIN || "duckhive";

  const child = spawn(duckhiveBin, ["start-grpc"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      GRPC_HOST: DUCKHIVE_GRPC_HOST,
      GRPC_PORT: DUCKHIVE_GRPC_PORT,
      // Disable TUI
      DISABLE_TUI: "true",
    },
  });

  child.stdout?.on("data", (data: Buffer) => {
    const output = data.toString();
    logger.info(`DuckHive gRPC: ${output.trim()}`);
    if (output.includes("running") || output.includes("listening")) {
      serverReady = true;
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    logger.warn(`DuckHive gRPC stderr: ${data.toString().trim()}`);
  });

  child.on("error", (err) => {
    logger.error(`DuckHive gRPC server error: ${err.message}`);
    serverProcess = null;
    serverReady = false;
  });

  child.on("exit", (code) => {
    logger.info(`DuckHive gRPC server exited with code ${code}`);
    serverProcess = null;
    serverReady = false;
  });

  return child;
}

/**
 * Wait for server to be ready
 */
async function waitForServerReady(timeoutMs = 30000): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    if (await isServerRunning()) {
      serverReady = true;
      logger.info("DuckHive gRPC server is ready");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("DuckHive gRPC server startup timeout");
}

/**
 * Ensure DuckHive gRPC server is running
 */
export async function ensureGrpcServerRunning(): Promise<void> {
  if (serverReady && serverProcess) {
    return;
  }

  if (serverReady && await isServerRunning()) {
    return;
  }

  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = (async () => {
    serverProcess = startServerProcess();
    await waitForServerReady();
    serverStartPromise = null;
  })();

  return serverStartPromise;
}

// Streaming event types
export interface TextChunk {
  type: "text-delta";
  textDelta: string;
}

export interface ToolStart {
  type: "tool-call-start";
  toolName: string;
  arguments: string;
  toolUseId: string;
}

export interface ToolResult {
  type: "tool-result";
  toolName: string;
  output: string;
  isError: boolean;
  toolUseId: string;
}

export interface ActionRequired {
  type: "action-required";
  promptId: string;
  question: string;
  actionType: "CONFIRM_COMMAND" | "REQUEST_INFORMATION";
}

export interface Done {
  type: "done";
  fullText: string;
  promptTokens: number;
  completionTokens: number;
}

export interface ErrorEvent {
  type: "error";
  message: string;
  code: string;
}

export type StreamEvent =
  | TextChunk
  | ToolStart
  | ToolResult
  | ActionRequired
  | Done
  | ErrorEvent;

/**
 * Create a streaming session with DuckHive gRPC server
 */
export async function createGrpcStreamSession(options: {
  message: string;
  workingDirectory: string;
  model?: string;
  sessionId?: string;
  onActionRequired?: (promptId: string, question: string) => Promise<string>;
}): Promise<{
  events: AsyncGenerator<StreamEvent>;
  cancel: () => void;
}> {
  await ensureGrpcServerRunning();

  const _proto = loadProto();
  // @ts-ignore - gRPC client creation is complex, using any for now
  const client = new (_proto.AgentService as any)(
    `${DUCKHIVE_GRPC_HOST}:${DUCKHIVE_GRPC_PORT}`,
    grpc.credentials.createInsecure()
  );

  const call = client.Chat() as grpc.ClientDuplexStream<any, any>;

  let _cancelled = false;
  let _resolveNext: ((value: IteratorResult<StreamEvent>) => void) | null = null;

  const eventEmitter = new EventEmitter();

  call.on("data", (message: any) => {
    if (message.text_chunk) {
      const event: TextChunk = {
        type: "text-delta",
        textDelta: message.text_chunk.text,
      };
      eventEmitter.emit("event", event);
    } else if (message.tool_start) {
      const event: ToolStart = {
        type: "tool-call-start",
        toolName: message.tool_start.tool_name,
        arguments: message.tool_start.arguments_json,
        toolUseId: message.tool_start.tool_use_id,
      };
      eventEmitter.emit("event", event);
    } else if (message.tool_result) {
      const event: ToolResult = {
        type: "tool-result",
        toolName: message.tool_result.tool_name,
        output: message.tool_result.output,
        isError: message.tool_result.is_error,
        toolUseId: message.tool_result.tool_use_id,
      };
      eventEmitter.emit("event", event);
    } else if (message.action_required) {
      const event: ActionRequired = {
        type: "action-required",
        promptId: message.action_required.prompt_id,
        question: message.action_required.question,
        actionType: message.action_required.type,
      };
      eventEmitter.emit("event", event);

      // If callback provided, auto-respond
      if (options.onActionRequired) {
        options.onActionRequired(event.promptId, event.question).then((reply) => {
          call.write({ input: { reply, prompt_id: event.promptId } });
        });
      }
    } else if (message.done) {
      const event: Done = {
        type: "done",
        fullText: message.done.full_text,
        promptTokens: message.done.prompt_tokens,
        completionTokens: message.done.completion_tokens,
      };
      eventEmitter.emit("event", event);
      eventEmitter.emit("end");
    } else if (message.error) {
      const event: ErrorEvent = {
        type: "error",
        message: message.error.message,
        code: message.error.code,
      };
      eventEmitter.emit("event", event);
      eventEmitter.emit("end");
    }
  });

  call.on("end", () => {
    eventEmitter.emit("end");
  });

  call.on("error", (err: Error) => {
    logger.error(`DuckHive gRPC stream error: ${err.message}`);
    eventEmitter.emit("error", err);
  });

  // Send initial request
  call.write({
    request: {
      message: options.message,
      working_directory: options.workingDirectory,
      model: options.model || "auto",
      session_id: options.sessionId || randomUUID(),
    },
  });

  // Event buffer for async iteration
  const events: StreamEvent[] = [];

  // Pump events from EventEmitter to the async generator
  const eventPump = new Promise<void>((resolve) => {
    eventEmitter.on("event", (event: StreamEvent) => {
      events.push(event);
    });
    eventEmitter.on("end", () => {
      eventEmitter.removeAllListeners();
      resolve();
    });
    eventEmitter.on("error", () => {
      eventEmitter.removeAllListeners();
      resolve();
    });
  });

  // Create async generator for events
  async function* eventGenerator(): AsyncGenerator<StreamEvent> {
    yield* events;
    await eventPump;
    while (events.length === 0) {
      await new Promise((r) => setTimeout(r, 50));
      yield* events.splice(0);
    }
  }

  return {
    events: eventGenerator() as AsyncGenerator<StreamEvent>,
    cancel: () => {
      _cancelled = true;
      call.write({ cancel: { reason: "user_cancelled" } });
      call.end();
    },
  };
}

/**
 * Create DuckHive gRPC provider (for use with ai SDK patterns)
 * Returns a provider object compatible with dyad's model client system
 */
export function createDuckHiveGrpcProvider() {
  return {
    name: "duckhive-grpc",

    languageModel(modelId: string) {
      return createDuckHiveGrpcLanguageModel(modelId);
    },
  };
}

interface GrpcLanguageModel {
  specificationVersion: "v3";
  modelId: string;
  provider: string;
  doGenerate: (options: any) => Promise<any>;
  doStream: (options: any) => Promise<any>;
}

function createDuckHiveGrpcLanguageModel(modelId: string): GrpcLanguageModel {
  return {
    specificationVersion: "v3",
    modelId,
    provider: "duckhive-grpc",

    async doGenerate(options: any) {
      const session = await createGrpcStreamSession({
        message: options.messages?.map((m: any) => `${m.role}: ${m.content}`).join("\n") || "",
        workingDirectory: process.cwd(),
        model: modelId,
      });

      let fullText = "";
      let finishReason: string | undefined;
      let usage = { promptTokens: 0, completionTokens: 0 };

      for await (const event of session.events) {
        if (event.type === "text-delta") {
          fullText += event.textDelta;
        } else if (event.type === "done") {
          finishReason = "stop";
          usage = {
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
          };
        }
      }

      return {
        text: fullText,
        finishReason,
        usage,
        rawCall: {},
        rawProvider: {},
      };
    },

    async doStream(options: any) {
      const session = await createGrpcStreamSession({
        message: options.messages?.map((m: any) => `${m.role}: ${m.content}`).join("\n") || "",
        workingDirectory: process.cwd(),
        model: modelId,
      });

      let _fullText = "";

      const stream = new ReadableStream({
        async start() {},
        async pull(_controller) {
          // This would need to be connected to the actual events
          // For now, returns a placeholder stream
        },
        cancel() {
          session.cancel();
        },
      });

      return {
        stream,
        rawCall: {},
        rawProvider: {},
      };
    },
  };
}

/**
 * Stop the gRPC server
 */
export function stopGrpcServer(): void {
  if (serverProcess) {
    logger.info("Stopping DuckHive gRPC server");
    serverProcess.kill();
    serverProcess = null;
    serverReady = false;
    serverStartPromise = null;
  }
}

/**
 * Get server status
 */
export function getGrpcServerStatus(): { running: boolean; pid: number | null } {
  return {
    running: serverReady,
    pid: serverProcess?.pid ?? null,
  };
}