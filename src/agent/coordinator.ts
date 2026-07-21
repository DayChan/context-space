import { EventEmitter } from "node:events";
import { AgentRepositoryStore } from "../machine";
import type { Logger } from "../logging";
import type { AgentRuntime } from "./contracts";

export class AgentSessionEvents {
  private readonly emitter = new EventEmitter();
  subscribe(listener: (sessionId: string) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }
  changed(sessionId: string): void { this.emitter.emit("changed", sessionId); }
}

export class AgentCoordinator {
  private readonly draining = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();

  constructor(
    private readonly store: AgentRepositoryStore,
    private readonly runtime: AgentRuntime,
    readonly events: AgentSessionEvents,
    private readonly logger: Logger
  ) {
    const interrupted = store.reconcileInterrupted();
    if (interrupted) this.logger.warn("agent.turns.interrupted_on_startup", { count: interrupted });
  }

  schedule(sessionId: string): void {
    if (this.draining.has(sessionId)) return;
    this.draining.add(sessionId);
    queueMicrotask(() => void this.drain(sessionId));
  }

  stop(sessionId: string): boolean {
    const controller = this.controllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  private async drain(sessionId: string): Promise<void> {
    try {
      let turn = this.store.nextQueuedTurn(sessionId);
      while (turn) {
        const session = this.store.getSession(sessionId);
        if (!session || session.status !== "active") break;
        const message = this.store.getMessage(turn.inputMessageId);
        if (!message) {
          this.store.failTurn(turn.id, "Turn 输入消息不存在");
          break;
        }
        this.store.startTurn(turn.id);
        this.events.changed(sessionId);
        const controller = new AbortController();
        this.controllers.set(sessionId, controller);
        this.logger.info("agent.turn.started", { session_id: sessionId, turn_id: turn.id, mode: session.mode });
        try {
          const result = await this.runtime.run({
            threadId: session.threadId,
            workingDirectory: session.workspacePath,
            mode: session.mode,
            prompt: message.content,
            signal: controller.signal,
            onEvent: (event) => {
              if (event.type === "thread.started" && typeof event.data.threadId === "string") {
                this.store.updateThreadId(sessionId, event.data.threadId);
              }
              this.store.addEvent(sessionId, turn!.id, event.type, event.data);
              this.events.changed(sessionId);
            }
          });
          this.store.completeTurn({ turnId: turn.id, ...result });
          this.logger.info("agent.turn.completed", { session_id: sessionId, turn_id: turn.id, outcome: result.outcome });
        } catch (error) {
          const cancelled = controller.signal.aborted;
          const rawMessage = error instanceof Error ? error.message : String(error);
          const messageText = rawMessage.length <= 16_000
            ? rawMessage
            : `${rawMessage.slice(0, 16_000)}\n…[truncated]`;
          this.store.failTurn(turn.id, messageText, cancelled ? "cancelled" : "failed");
          this.logger.warn("agent.turn.failed", { session_id: sessionId, turn_id: turn.id, cancelled, error });
        } finally {
          this.controllers.delete(sessionId);
          this.events.changed(sessionId);
        }
        turn = this.store.nextQueuedTurn(sessionId);
      }
    } finally {
      this.draining.delete(sessionId);
      if (this.store.getSession(sessionId)?.status === "active" && this.store.nextQueuedTurn(sessionId)) {
        this.schedule(sessionId);
      }
    }
  }
}
