/**
 * Branded ID types. They are plain strings at runtime, but the compiler keeps
 * an AgentId from being passed where a WorkspaceId is expected.
 */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, "WorkspaceId">;
export type UserId = Brand<string, "UserId">;
export type AgentId = Brand<string, "AgentId">;
export type ThreadId = Brand<string, "ThreadId">;
export type MessageId = Brand<string, "MessageId">;
export type RunId = Brand<string, "RunId">;
export type RunEventId = Brand<string, "RunEventId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ApprovalId = Brand<string, "ApprovalId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type SecretId = Brand<string, "SecretId">;
export type MemoryId = Brand<string, "MemoryId">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type DeviceId = Brand<string, "DeviceId">;

/** Cast a string that is known to be a valid ID (e.g. read from the database). */
export function asId<T extends Brand<string, string>>(value: string): T {
  return value as T;
}
