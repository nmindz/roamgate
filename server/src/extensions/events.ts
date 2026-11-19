import {
  type ExtensionEventBase,
  isActionEvent,
} from "../../../shared/extensions";
import type { Logger } from "../utils/logger";
import { combineGates, type DecidedGate } from "./guard";

/** How a subscriber's handlers may affect an event. */
export type DispatchMode = "observe" | "answer" | "gate";

export interface DispatchOutcome {
  /** The event after validated rewrites. */
  event: ExtensionEventBase;
  /** Set when a handler answered (answer mode). */
  answer?: { ext: string; value: unknown };
  /** Set when handlers gated (gate mode). */
  gate?: DecidedGate;
}

/** Something that runs handlers for events: the mod host, command hooks. */
export interface EventSubscriber {
  wants(name: string): boolean;
  dispatch(
    event: ExtensionEventBase,
    mode: DispatchMode,
  ): Promise<DispatchOutcome>;
}

export interface GateResult {
  gate: DecidedGate;
  event: ExtensionEventBase;
}

const ALLOW: DecidedGate = { decision: "allow" };

/** An event as producers build it; `at` defaults to now. */
export type EventInput = { name: string; at?: number } & Omit<
  ExtensionEventBase,
  "name" | "at"
>;

function stamp(event: EventInput): ExtensionEventBase {
  return { ...event, at: event.at ?? Date.now() };
}

/**
 * Producers emit observed events and await gates on action events. With no
 * subscriber for an event, `wants` is false and the calls return at once;
 * producers with costly payloads check `wants` before building them.
 */
export class ExtensionBus {
  private readonly subscribers: EventSubscriber[] = [];

  constructor(private readonly logger: Logger) {}

  add(subscriber: EventSubscriber): () => void {
    this.subscribers.push(subscriber);
    return () => {
      const index = this.subscribers.indexOf(subscriber);
      if (index >= 0) this.subscribers.splice(index, 1);
    };
  }

  wants(name: string): boolean {
    for (const subscriber of this.subscribers)
      if (subscriber.wants(name)) return true;
    return false;
  }

  /** Observe-only: never awaited by producers, never throws into them. */
  emit(input: EventInput): void {
    if (!this.wants(input.name)) return;
    const event = stamp(input);
    for (const subscriber of this.subscribers) {
      if (!subscriber.wants(event.name)) continue;
      subscriber.dispatch(event, "observe").catch((error) =>
        this.logger.warn("extension event failed", {
          event: event.name,
          error,
        }),
      );
    }
  }

  /**
   * Runs answerable handlers in order; the first answer stops the chain. The
   * event carries rewrites from handlers that continued.
   */
  async run(input: EventInput): Promise<DispatchOutcome> {
    let event = stamp(input);
    for (const subscriber of this.subscribers) {
      if (!subscriber.wants(event.name)) continue;
      const current = event;
      const outcome = await subscriber
        .dispatch(current, "answer")
        .catch((error): DispatchOutcome => {
          this.logger.warn("extension event failed", {
            event: current.name,
            error,
          });
          return { event: current };
        });
      event = outcome.event;
      if (outcome.answer) return { event, answer: outcome.answer };
    }
    return { event };
  }

  /**
   * Gates combine across every subscriber as deny > ask > allow. Without a
   * subscriber the result is synchronous, so ungated actions pay nothing.
   */
  gate(input: EventInput): GateResult | Promise<GateResult> {
    if (!isActionEvent(input.name) && input.name !== "rpc.call")
      throw new Error(`not an action event: ${input.name}`);
    if (!this.wants(input.name)) return { gate: ALLOW, event: stamp(input) };
    return this.gateSubscribers(stamp(input));
  }

  private async gateSubscribers(
    initial: ExtensionEventBase,
  ): Promise<GateResult> {
    let event = initial;
    const gates: DecidedGate[] = [];
    for (const subscriber of this.subscribers) {
      if (!subscriber.wants(event.name)) continue;
      let outcome: DispatchOutcome;
      try {
        outcome = await subscriber.dispatch(event, "gate");
      } catch (error) {
        // Subscribers apply their own failure policy; reaching here means the
        // subscriber itself broke, which never blocks an action.
        this.logger.warn("extension gate failed", { event: event.name, error });
        continue;
      }
      event = outcome.event;
      if (outcome.gate) gates.push(outcome.gate);
      if (outcome.gate?.decision === "deny") break;
    }
    return { gate: combineGates(gates), event };
  }
}
