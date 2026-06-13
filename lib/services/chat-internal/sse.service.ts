/**
 * SSE Client Registry for Chat Module
 *
 * In-memory registry of connected SSE clients per workspace.
 * Each workspace maps to a set of named clients, each holding
 * a ReadableStream controller for pushing events.
 *
 * This is a singleton module — all route handlers share the same
 * Maps in the Node.js process. Survives hot-reload in dev because
 * we anchor to globalThis.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type SSEEventType =
  | "connected"
  | "new_message"
  | "message_edited"
  | "message_deleted"
  | "typing"
  | "channel_created"
  | "channel_updated"
  | "channel_deleted"
  | "reaction_toggled"
  | "message_pinned"
  | "online_status";

export type SSEEvent = {
  type: SSEEventType;
  data: unknown;
};

type SSEClient = {
  controller: ReadableStreamDefaultController;
  encoder: TextEncoder;
  userId: string;
  connectedAt: number;
};

type WorkspaceClients = Map<string, SSEClient>;

// ─── Singleton anchor (survives Next.js HMR in dev) ─────────────────────────

const globalForSSE = globalThis as unknown as {
  __chatSSEClients?: Map<string, WorkspaceClients>;
};

if (!globalForSSE.__chatSSEClients) {
  globalForSSE.__chatSSEClients = new Map();
}

const clients: Map<string, WorkspaceClients> = globalForSSE.__chatSSEClients;

// ─── Client management ──────────────────────────────────────────────────────

export function addSSEClient(
  workspaceId: string,
  clientId: string,
  userId: string,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
): void {
  let wsClients = clients.get(workspaceId);
  if (!wsClients) {
    wsClients = new Map();
    clients.set(workspaceId, wsClients);
  }
  wsClients.set(clientId, {
    controller,
    encoder,
    userId,
    connectedAt: Date.now(),
  });
}

export function removeSSEClient(workspaceId: string, clientId: string): void {
  const wsClients = clients.get(workspaceId);
  if (!wsClients) return;
  wsClients.delete(clientId);
  if (wsClients.size === 0) {
    clients.delete(workspaceId);
  }
}

// ─── Broadcasting ───────────────────────────────────────────────────────────

/**
 * Send an event to ALL connected clients in a workspace.
 * Dead connections are automatically cleaned up.
 */
export function broadcastToWorkspace(
  workspaceId: string,
  event: SSEEvent,
): void {
  const wsClients = clients.get(workspaceId);
  if (!wsClients || wsClients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const dead: string[] = [];

  wsClients.forEach((client, id) => {
    try {
      client.controller.enqueue(client.encoder.encode(payload));
    } catch {
      // Connection is dead — mark for removal
      dead.push(id);
    }
  });

  dead.forEach((id) => wsClients.delete(id));

  // Clean up empty workspace entry
  if (wsClients.size === 0) {
    clients.delete(workspaceId);
  }
}

/**
 * Send an event ONLY to clients whose userId is in `memberUserIds`.
 * Pass `null` to broadcast to ALL workspace clients (PUBLIC/GENERAL channels).
 * For PRIVATE/DM channels pass the channel members so non-members never receive
 * the content over the wire (the core PRIVATE/DM leak fix). `excludeUserId`
 * optionally drops the sender (used for typing).
 */
export function broadcastToChannelMembers(
  workspaceId: string,
  memberUserIds: string[] | null,
  event: SSEEvent,
  excludeUserId?: string,
): void {
  const wsClients = clients.get(workspaceId);
  if (!wsClients || wsClients.size === 0) return;

  const allowed = memberUserIds ? new Set(memberUserIds) : null;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const dead: string[] = [];

  wsClients.forEach((client, id) => {
    if (allowed && !allowed.has(client.userId)) return;
    if (excludeUserId && client.userId === excludeUserId) return;
    try {
      client.controller.enqueue(client.encoder.encode(payload));
    } catch {
      dead.push(id);
    }
  });

  dead.forEach((id) => wsClients.delete(id));
  if (wsClients.size === 0) clients.delete(workspaceId);
}

/**
 * Send an event to all clients in a workspace EXCEPT the sender.
 * Useful for typing indicators — the sender already knows they are typing.
 */
export function broadcastToOthers(
  workspaceId: string,
  excludeUserId: string,
  event: SSEEvent,
): void {
  const wsClients = clients.get(workspaceId);
  if (!wsClients || wsClients.size === 0) return;

  const payload = `data: ${JSON.stringify(event)}\n\n`;
  const dead: string[] = [];

  wsClients.forEach((client, id) => {
    if (client.userId === excludeUserId) return;
    try {
      client.controller.enqueue(client.encoder.encode(payload));
    } catch {
      dead.push(id);
    }
  });

  dead.forEach((id) => wsClients.delete(id));

  if (wsClients.size === 0) {
    clients.delete(workspaceId);
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────

/** Returns the number of connected clients per workspace (for monitoring). */
export function getSSEStats(): Record<string, number> {
  const stats: Record<string, number> = {};
  clients.forEach((wsClients, wsId) => {
    stats[wsId] = wsClients.size;
  });
  return stats;
}

/** Returns all connected user IDs in a workspace (for online status). */
export function getConnectedUserIds(workspaceId: string): string[] {
  const wsClients = clients.get(workspaceId);
  if (!wsClients) return [];
  const userIds = new Set<string>();
  wsClients.forEach((client) => {
    userIds.add(client.userId);
  });
  return Array.from(userIds);
}
