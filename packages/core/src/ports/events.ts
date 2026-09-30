/**
 * Live updates for clients (ADR-0007). Payloads stay small: they carry IDs,
 * and subscribers fetch details from the database.
 */
export interface BusEvent<TPayload = unknown> {
  readonly topic: string;
  readonly payload: TPayload;
}

export type Unsubscribe = () => Promise<void>;

export interface EventBus {
  publish<TPayload>(event: BusEvent<TPayload>): Promise<void>;
  subscribe<TPayload>(
    topic: string,
    handler: (event: BusEvent<TPayload>) => void | Promise<void>,
  ): Promise<Unsubscribe>;
}
