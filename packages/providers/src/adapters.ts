// Wire-shape adapters — Plan §10/§12/§13. Translators only (policy lives in the
// dispatcher). Every adapter: normalized ModelRecord out of provider discovery,
// normalized ChatResponse out of completion endpoints. Unknown finish reasons map
// to "error" (fail closed — a silent mis-map could drop evidence of truncation).
import { DEFAULT_MODEL_CONTEXT_WINDOW } from "../../storage/src/dao-providers.ts";
import { ProviderError } from "./errors.ts";
import { BaseAdapter, type AdapterDeps, type ProviderConfig } from "./base.ts";
import { dotPath } from "./http.ts";
import type {
  ChatRequest,
  ChatResponse,
  ModelCapability,
  ModelRecord,
  ModelStatus,
  ProviderProtocol,
} from "./index.ts";

/** Conservative declared capabilities until probes verify (registry marks unverified). */
function declaredChatCapabilities(): Record<ModelCapability, boolean> {
  return {
    text: true,
    vision: false,
    audio: false,
    tools: false, // verified by probes in P2.5 before tools become usable
    "structured-output": false,
    reasoning: false,
    coding: false,
    "long-context": false,
    streaming: false,
    "parallel-tools": false,
    "computer-use": false,
    embeddings: false,
    "image-generation": false,
  };
}

export function toModelRecord(
  providerId: string,
  nativeId: string,
  extra: { readonly contextWindow?: number } = {},
): ModelRecord {
  return Object.freeze({
    id: `${providerId}:${nativeId}`,
    providerId,
    displayName: nativeId,
    capabilities: declaredChatCapabilities(),
    contextWindow: extra.contextWindow ?? DEFAULT_MODEL_CONTEXT_WINDOW,
    declaredCapabilitiesVerified: false,
    status: "unverified" satisfies ModelStatus,
  });
}

type FinishReason = ChatResponse["finishReason"];

function okResponse(model: string, content: string, finish: FinishReason, usage?: {
  readonly input: number;
  readonly output: number;
}): ChatResponse {
  return Object.freeze({
    model,
    content,
    finishReason: finish,
    usage:
      usage === undefined
        ? undefined
        : Object.freeze({ inputTokens: usage.input, outputTokens: usage.output }),
  });
}

/* ---------------------------------- OpenAI ---------------------------------- */

interface OpenAiMessage {
  readonly role: string;
  readonly content: string;
}

export class OpenAIChatAdapter extends BaseAdapter {
  protected modelsPath(): string {
    return "/models";
  }
  protected chatPath(): string {
    return "/chat/completions";
  }

  async listModels(): Promise<readonly ModelRecord[]> {
    const data = (await this.json("GET", this.modelsPath())) as { data?: unknown };
    const list = Array.isArray(data?.data) ? data.data : [];
    const out: ModelRecord[] = [];
    for (const m of list) {
      const id = (m as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") out.push(toModelRecord(this.id, id));
    }
    return Object.freeze(out);
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: request.model,
      messages: request.messages as unknown as readonly OpenAiMessage[],
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const data = (await this.json("POST", this.chatPath(), body)) as {
      model?: unknown;
      choices?: unknown;
      usage?: unknown;
    };
    const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
    if (choice === undefined || typeof choice !== "object") {
      throw new ProviderError("VALIDATION", "completion response has no choices[0]", {
        providerId: this.id,
      });
    }
    const msg = (choice as { message?: unknown }).message as
      | { content?: unknown }
      | undefined;
    const content = openAiContentToString(msg?.content);
    const nativeFinish = String((choice as { finish_reason?: unknown }).finish_reason ?? "");
    const finish = mapOpenAiFinish(nativeFinish);
    const usage = data.usage as
      | { prompt_tokens?: unknown; completion_tokens?: unknown }
      | undefined;
    return okResponse(
      typeof data.model === "string" ? data.model : request.model,
      content,
      finish,
      typeof usage?.prompt_tokens === "number" && typeof usage.completion_tokens === "number"
        ? { input: usage.prompt_tokens, output: usage.completion_tokens }
        : undefined,
    );
  }
}

function openAiContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part !== null && typeof part === "object") {
          const p = part as { type?: unknown; text?: unknown };
          if (p.type === "text" && typeof p.text === "string") return p.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

function mapOpenAiFinish(v: string): FinishReason {
  switch (v) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "":
      return "stop"; // some proxies omit it
    default:
      return "error"; // content_filter & friends — fail closed
  }
}

/* --------------------------------- NVIDIA NIM -------------------------------- */

/** NVIDIA NIM is OpenAI-compatible at a different origin (Plan §12 checklist). */
export class NvidiaNimAdapter extends OpenAIChatAdapter {}

/* --------------------------------- Anthropic --------------------------------- */

export class AnthropicAdapter extends BaseAdapter {
  private anthropicVersion(): string {
    const v = this.config["anthropicVersion"];
    return typeof v === "string" && v !== "" ? v : "2023-06-01";
  }

  protected override async authHeaders(): Promise<Record<string, string>> {
    if (this.credentialRef === undefined) {
      throw new ProviderError("AUTH", "anthropic provider requires a credential ref", {
        providerId: this.id,
      });
    }
    if (this.deps.resolveKey === undefined) {
      throw new ProviderError("AUTH", "provider has credentials but no vault resolver", {
        providerId: this.id,
      });
    }
    const key = await this.deps.resolveKey(this.credentialRef);
    return { "x-api-key": key, "anthropic-version": this.anthropicVersion() };
  }

  async listModels(): Promise<readonly ModelRecord[]> {
    const data = (await this.json("GET", "/v1/models", undefined, {}, 15_000)) as {
      data?: unknown;
    };
    const list = Array.isArray(data?.data) ? data.data : [];
    const out: ModelRecord[] = [];
    for (const m of list.slice(0, 100)) {
      const id = (m as { id?: unknown }).id;
      if (typeof id === "string" && id !== "") out.push(toModelRecord(this.id, id));
    }
    return Object.freeze(out);
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const system: string[] = [];
    const messages: { role: string; content: string }[] = [];
    for (const m of request.messages) {
      if (m.role === "system") system.push(m.content);
      else if (m.role === "user" || m.role === "assistant") {
        messages.push({ role: m.role, content: m.content });
      } else {
        throw new ProviderError(
          "VALIDATION",
          `message role "${m.role}" unsupported by anthropic adapter (tools land in Phase 3)`,
          { providerId: this.id },
        );
      }
    }
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 1024,
      messages,
      ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const data = (await this.json("POST", "/v1/messages", body)) as {
      content?: unknown;
      stop_reason?: unknown;
      usage?: unknown;
      model?: unknown;
    };
    const blocks = Array.isArray(data?.content) ? data.content : [];
    const text = blocks
      .filter(
        (b): b is { type: string; text: string } =>
          b !== null &&
          typeof b === "object" &&
          (b as { type?: unknown }).type === "text" &&
          typeof (b as { text?: unknown }).text === "string",
      )
      .map((b) => b.text)
      .join("");
    const finish = mapAnthropicStop(String(data?.stop_reason ?? ""));
    const usage = data.usage as
      | { input_tokens?: unknown; output_tokens?: unknown }
      | undefined;
    return okResponse(
      typeof data.model === "string" ? data.model : request.model,
      text,
      finish,
      typeof usage?.input_tokens === "number" && typeof usage.output_tokens === "number"
        ? { input: usage.input_tokens, output: usage.output_tokens }
        : undefined,
    );
  }
}

function mapAnthropicStop(v: string): FinishReason {
  switch (v) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "":
      return "stop";
    default:
      return "error"; // refusal / pause_turn — fail closed
  }
}

/* ------------------------------ Generic REST ------------------------------- */

interface GenericConfigShape {
  readonly modelsPath?: string;
  readonly modelsListPath?: string;
  readonly modelsIdPath?: string;
  readonly chatPath?: string;
  readonly contentPath?: string;
  readonly usageInputPath?: string;
  readonly usageOutputPath?: string;
  readonly keyStyle?: "bearer" | "x-api-key" | "none";
}

function s<T extends string>(cfg: Readonly<Record<string, unknown>>, key: string, dflt: T): T {
  const v = cfg[key];
  return typeof v === "string" && v !== "" ? (v as T) : dflt;
}

/** Operator-pinned REST provider (Plan §12 generic adapter). Config: see GenericConfigShape. */
export class GenericRestAdapter extends BaseAdapter {
  private cfg(): GenericConfigShape {
    return this.config;
  }

  protected override async authHeaders(): Promise<Record<string, string>> {
    const style = this.cfg().keyStyle ?? "bearer";
    if (style === "none") return {};
    if (this.credentialRef === undefined) {
      throw new ProviderError("AUTH", `generic provider keyStyle=${style} requires credentials`, {
        providerId: this.id,
      });
    }
    if (this.deps.resolveKey === undefined) {
      throw new ProviderError("AUTH", "provider has credentials but no vault resolver", {
        providerId: this.id,
      });
    }
    const key = await this.deps.resolveKey(this.credentialRef);
    return style === "x-api-key" ? { "x-api-key": key } : { authorization: `Bearer ${key}` };
  }

  async listModels(): Promise<readonly ModelRecord[]> {
    const data = await this.json("GET", s(this.config, "modelsPath", "models"));
    const list = dotPath(data, s(this.config, "modelsListPath", "data"));
    const idPath = s(this.config, "modelsIdPath", "id");
    if (!Array.isArray(list)) return Object.freeze([]);
    const out: ModelRecord[] = [];
    for (const m of list) {
      const id = dotPath(m, idPath);
      if (typeof id === "string" && id !== "") out.push(toModelRecord(this.id, id));
    }
    return Object.freeze(out);
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: request.model,
      messages: request.messages,
      ...(request.maxTokens !== undefined ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
    const data = await this.json("POST", s(this.config, "chatPath", "chat/completions"), body);
    const content = dotPath(data, s(this.config, "contentPath", "choices.0.message.content"));
    if (typeof content !== "string") {
      throw new ProviderError("VALIDATION", "response missing configured content path", {
        providerId: this.id,
      });
    }
    const input = dotPath(data, s(this.config, "usageInputPath", "usage.prompt_tokens"));
    const output = dotPath(data, s(this.config, "usageOutputPath", "usage.completion_tokens"));
    return okResponse(
      request.model,
      content,
      "stop",
      typeof input === "number" && typeof output === "number"
        ? { input, output }
        : undefined,
    );
  }
}

/* ---------------------------------- Factory ---------------------------------- */

const CONSTRUCTORS: Record<string, new (cfg: ProviderConfig, deps: AdapterDeps) => BaseAdapter> = {
  "openai-chat": OpenAIChatAdapter,
  "anthropic-messages": AnthropicAdapter,
  "nvidia-nim": NvidiaNimAdapter,
  "generic-rest": GenericRestAdapter,
  "local-openai-compatible": class extends OpenAIChatAdapter {},
};

/** Default endpoints per protocol — operator baseUrl wins when provided. */
export const PROTOCOL_DEFAULT_BASE: Readonly<Record<string, string>> = Object.freeze({
  "openai-chat": "https://api.openai.com/v1",
  "anthropic-messages": "https://api.anthropic.com",
  "nvidia-nim": "https://integrate.api.nvidia.com/v1",
  "local-openai-compatible": "http://127.0.0.1:1234/v1",
  "generic-rest": "",
});

export function createAdapter(cfg: ProviderConfig, deps: AdapterDeps): BaseAdapter {
  const Ctor = CONSTRUCTORS[cfg.protocol];
  if (Ctor === undefined) {
    throw new ProviderError("PROTOCOL_UNSUPPORTED", `no adapter for protocol: ${cfg.protocol}`, {
      providerId: cfg.id,
    });
  }
  return new Ctor(cfg, deps);
}
