// Provider dispatcher — Plan §13/§36, threats T5/T10/T11. The single chokepoint every
// provider I/O flows through; adapters can translate but can NEVER waive a gate:
//   1. classification gate — context data level ≤ provider clearance (else DENIED)
//   2. egress gate — endpoint policy (https remote / loopback-only local) per request
//   3. secret gate — outbound message content scanned (T11, fail closed)
//   4. key resolution — vault ref → value at the narrow call site, never stored/logged
// Denials and completions are reported to the audit sink with NO message content.

import { classificationAllowed, type DataClassification } from "../../core/src/index.ts";
import {
  containsSecret,
  detectSecretKinds,
  redact,
} from "../../security/src/redact.ts";
import { secretRef, type SecretVault } from "../../secrets/src/index.ts";
import { ProviderError } from "./errors.ts";
import {
  assertProviderEndpoint,
  fetchTransport,
  type Transport,
} from "./http.ts";
import { BaseAdapter, type ProviderConfig } from "./base.ts";
import { createAdapter } from "./adapters.ts";
import type {
  ChatRequest,
  ChatResponse,
  ModelRecord,
  ProviderHealth,
} from "./index.ts";

/** Structured, content-free events for the audit trail (CLI/session layer wires it). */
export interface ProviderEvent {
  readonly kind:
    | "provider.dispatch.completed"
    | "provider.dispatch.denied"
    | "provider.dispatch.failed"
    | "provider.connection.tested"
    | "provider.route.hop"
    | "provider.route.exhausted";
  readonly providerId: string;
  readonly model?: string;
  readonly code?: string;
  readonly detail?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export type ProviderEventSink = (event: ProviderEvent) => void;

export interface DispatcherDeps {
  readonly vault?: SecretVault;
  readonly transport?: Transport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly audit?: ProviderEventSink;
}

export interface ConnectionReport {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly modelsFound?: number;
  /** Redacted, content-free explanation when ok=false. */
  readonly detail?: string;
}

export class ProviderDispatcher {
  private readonly deps: DispatcherDeps;
  private readonly transport: Transport;

  constructor(deps: DispatcherDeps = {}) {
    this.deps = deps;
    this.transport = deps.transport ?? fetchTransport();
  }

  private emit(event: ProviderEvent): void {
    this.deps.audit?.(event);
  }

  /** Vault ref → value: the narrowest call site that ever sees a raw key. */
  private readonly resolveKey = async (ref: string): Promise<string> => {
    if (this.deps.vault === undefined) {
      throw new ProviderError("AUTH", "credentials configured but no vault available");
    }
    try {
      const value = await this.deps.vault.load(secretRef(ref));
      return String(value);
    } catch (err) {
      throw new ProviderError("AUTH", `credential load failed: ${redact(String(err instanceof Error ? err.message : err)).text}`);
    }
  };

  private adapterFor(config: ProviderConfig): BaseAdapter {
    return createAdapter(config, {
      transport: this.transport,
      timeoutMs: this.deps.timeoutMs,
      maxResponseBytes: this.deps.maxResponseBytes,
      resolveKey: this.resolveKey,
    });
  }

  /** Gates shared by every operation. Throws ProviderError on any denial. */
  private gate(config: ProviderConfig, opts: { contextClassification?: DataClassification }): void {
    assertProviderEndpoint(config.baseUrl, config.protocol);
    if (opts.contextClassification !== undefined) {
      if (!classificationAllowed(opts.contextClassification, config.maxClassification)) {
        throw new ProviderError(
          "CLASSIFICATION_DENIED",
          `context classified "${opts.contextClassification}" exceeds provider clearance "${config.maxClassification}"`,
          { providerId: config.id },
        );
      }
    }
  }

  /** Outgoing secret gate (T11): any message looking like a credential stops cold. */
  private gateOutbound(config: ProviderConfig, request: ChatRequest): void {
    for (const m of request.messages) {
      if (containsSecret(m.content)) {
        const kinds = detectSecretKinds(m.content).join(",");
        throw new ProviderError(
          "SECRET_IN_REQUEST",
          `outbound content matches secret patterns (${kinds}) — redact before dispatch`,
          { providerId: config.id },
        );
      }
    }
  }

  async complete(
    config: ProviderConfig,
    request: ChatRequest,
    opts: { contextClassification: DataClassification },
  ): Promise<ChatResponse> {
    try {
      this.gate(config, opts);
      this.gateOutbound(config, request);
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "VALIDATION";
      this.emit({
        kind: "provider.dispatch.denied",
        providerId: config.id,
        model: request.model,
        code,
        detail: err instanceof Error ? redact(err.message).text : "denied",
      });
      throw err;
    }
    try {
      const res = await this.adapterFor(config).complete(request);
      this.emit({
        kind: "provider.dispatch.completed",
        providerId: config.id,
        model: request.model,
        inputTokens: res.usage?.inputTokens,
        outputTokens: res.usage?.outputTokens,
      });
      return res;
    } catch (err) {
      const code = err instanceof ProviderError ? err.code : "SERVER";
      this.emit({
        kind: "provider.dispatch.failed",
        providerId: config.id,
        model: request.model,
        code,
        detail: err instanceof Error ? redact(err.message).text : "failed",
      });
      throw err;
    }
  }

  async listModels(config: ProviderConfig): Promise<readonly ModelRecord[]> {
    this.gate(config, {});
    return this.adapterFor(config).listModels();
  }

  async health(config: ProviderConfig): Promise<ProviderHealth> {
    this.gate(config, {});
    return this.adapterFor(config).health();
  }

  /**
   * Structured connection test (Plan §13): endpoint policy + auth + discovery probe.
   * Never leaks response bodies, stack traces, or secrets — only redacted, coded detail.
   */
  async testConnection(config: ProviderConfig): Promise<ConnectionReport> {
    const started = Date.now();
    try {
      const models = await this.listModels(config);
      // Auth sanity: complete a minimal probe only if credentials are expected and the
      // operator asked (models list already exercises auth on most providers).
      const report: ConnectionReport = {
        ok: true,
        latencyMs: Date.now() - started,
        modelsFound: models.length,
      };
      this.emit({
        kind: "provider.connection.tested",
        providerId: config.id,
        detail: `ok (${models.length} models)`,
      });
      return Object.freeze(report);
    } catch (err) {
      const detail = err instanceof Error ? redact(err.message).text : "connection failed";
      this.emit({
        kind: "provider.connection.tested",
        providerId: config.id,
        code: err instanceof ProviderError ? err.code : "NETWORK",
        detail,
      });
      return Object.freeze({
        ok: false,
        latencyMs: Date.now() - started,
        detail,
      });
    }
  }
}
