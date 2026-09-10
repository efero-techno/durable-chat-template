import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

type AppearanceState = { type?: "sport" | "costume" | "planet"; id?: string };
type PlayerState = {
  status: "idle" | "presence" | "waiting" | "matched";
  clientId?: string;
  peerId?: string;
  peerClientId?: string;
  matchId?: string;
  side?: "A" | "B";
  score?: number;
  appearance?: AppearanceState | null;
};

type PendingReconnect = {
  matchId: string;
  side: "A" | "B";
  clientId: string;
  peerClientId: string;
  appearance?: AppearanceState | null;
  expiresAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export class Chat extends Server<Env> {
  static options = { hibernate: true };
  reconnectGraceMs = 7000;
  pendingReconnects = new Map<string, PendingReconnect>();

  cleanClientId(value: unknown) {
    return typeof value === "string" && value.length > 0 ? value.slice(0, 96) : undefined;
  }

  cleanAppearance(value: unknown): AppearanceState | null {
    if (!value || typeof value !== "object") return null;
    const data = value as Record<string, unknown>;
    const type = data.type === "sport" || data.type === "costume" || data.type === "planet" ? data.type : undefined;
    const id = typeof data.id === "string" ? data.id.slice(0, 96) : undefined;
    return type && id ? { type, id } : null;
  }

  findByClientId(clientId?: string) {
    if (!clientId) return null;
    for (const c of this.getConnections()) {
      const state = c.state as PlayerState | null;
      if (state?.clientId === clientId) return c;
    }
    return null;
  }

  onlineCount(excludeConnectionId?: string) {
    const ids = new Set<string>();
    for (const c of this.getConnections()) {
      if (c.id === excludeConnectionId) continue;
      const state = c.state as PlayerState | null;
      if (state?.clientId) ids.add(state.clientId);
    }
    return ids.size;
  }

  broadcastPresence(excludeConnectionId?: string) {
    const payload = JSON.stringify({ type: "presence", online: this.onlineCount(excludeConnectionId) });
    for (const c of this.getConnections()) {
      if (c.id === excludeConnectionId) continue;
      try { c.send(payload); } catch {}
    }
  }

  findWaiting(excludeId: string, clientId?: string) {
    for (const c of this.getConnections()) {
      if (c.id === excludeId) continue;
      const state = c.state as PlayerState | null;
      if (!state || state.status !== "waiting") continue;
      if (clientId && state.clientId === clientId) continue;
      return c;
    }
    return null;
  }

  pairPlayers(a: Connection, b: Connection) {
    const aState = (a.state as PlayerState | null) ?? { status: "waiting" };
    const bState = (b.state as PlayerState | null) ?? { status: "waiting" };
    const matchId = crypto.randomUUID();

    a.setState({
      status: "matched", clientId: aState.clientId, peerId: b.id, peerClientId: bState.clientId,
      matchId, side: "A", score: 0, appearance: aState.appearance ?? null,
    });
    b.setState({
      status: "matched", clientId: bState.clientId, peerId: a.id, peerClientId: aState.clientId,
      matchId, side: "B", score: 0, appearance: bState.appearance ?? null,
    });

    a.send(JSON.stringify({ type: "matched", matchId, side: "A", opponentAppearance: bState.appearance ?? null }));
    b.send(JSON.stringify({ type: "matched", matchId, side: "B", opponentAppearance: aState.appearance ?? null }));
  }

  tryReconnect(connection: Connection, clientId?: string, appearance?: AppearanceState | null) {
    if (!clientId) return false;
    const pending = this.pendingReconnects.get(clientId);
    if (!pending || pending.expiresAt < Date.now()) return false;

    const opponent = this.findByClientId(pending.peerClientId);
    if (!opponent) return false;
    const os = opponent.state as PlayerState | null;
    if (!os || os.status !== "matched" || os.matchId !== pending.matchId) return false;

    if (pending.timer) clearTimeout(pending.timer);
    this.pendingReconnects.delete(clientId);

    connection.setState({
      status: "matched",
      clientId,
      peerId: opponent.id,
      peerClientId: pending.peerClientId,
      matchId: pending.matchId,
      side: pending.side,
      score: 0,
      appearance: appearance ?? pending.appearance ?? null,
    });

    opponent.setState({
      ...os,
      peerId: connection.id,
      peerClientId: clientId,
      status: "matched",
    });

    connection.send(JSON.stringify({
      type: "reconnected",
      matchId: pending.matchId,
      side: pending.side,
      opponentAppearance: os.appearance ?? null,
    }));
    opponent.send(JSON.stringify({ type: "opponent_reconnected" }));
    return true;
  }

  tryMatch(connection: Connection) {
    const state = connection.state as PlayerState | null;
    const other = this.findWaiting(connection.id, state?.clientId);
    if (!other) {
      connection.setState({ ...state, status: "waiting", score: 0 });
      connection.send(JSON.stringify({ type: "waiting" }));
      return;
    }
    this.pairPlayers(other, connection);
  }

  onConnect(connection: Connection) {
    connection.setState({ status: "idle", score: 0 });
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string" || message.length > 8192) return;
    let data: any;
    try { data = JSON.parse(message); } catch { return; }

    if (data.type === "ping") {
      connection.send(JSON.stringify({ type: "pong", time: Date.now() }));
      return;
    }

    if (data.type === "presence") {
      connection.setState({ status: "presence", clientId: this.cleanClientId(data.clientId), score: 0 });
      this.broadcastPresence();
      return;
    }

    if (data.type === "queue") {
      const oldState = connection.state as PlayerState | null;
      const clientId = this.cleanClientId(data.clientId) ?? oldState?.clientId;
      const appearance = this.cleanAppearance(data.appearance);

      if (this.tryReconnect(connection, clientId, appearance)) {
        this.broadcastPresence();
        return;
      }

      connection.setState({ status: "waiting", clientId, score: 0, appearance });
      this.tryMatch(connection);
      this.broadcastPresence();
      return;
    }

    if (data.type === "cancel_queue") {
      const oldState = connection.state as PlayerState | null;
      connection.setState({ status: "idle", clientId: oldState?.clientId, score: 0, appearance: oldState?.appearance ?? null });
      this.broadcastPresence();
      return;
    }

    const state = connection.state as PlayerState | null;
    if (!state || state.status !== "matched" || !state.peerId) {
      connection.send(JSON.stringify({ type: "waiting" }));
      return;
    }

    const opponent = this.getConnection(state.peerId);
    if (!opponent) {
      const pending = state.peerClientId ? this.pendingReconnects.get(state.peerClientId) : undefined;
      if (pending && pending.matchId === state.matchId && pending.expiresAt >= Date.now()) return;

      connection.setState({ status: "idle", clientId: state.clientId, score: 0, appearance: state.appearance ?? null });
      connection.send(JSON.stringify({ type: "opponent_left" }));
      return;
    }

    if (data.type === "result") {
      opponent.send(JSON.stringify({ ...data, from: connection.id, matchId: state.matchId, serverTime: Date.now() }));
      const os = opponent.state as PlayerState | null;
      connection.setState({ status: "idle", clientId: state.clientId, score: 0, appearance: state.appearance ?? null });
      opponent.setState({ status: "idle", clientId: os?.clientId, score: 0, appearance: os?.appearance ?? null });
      return;
    }

    opponent.send(JSON.stringify({ ...data, from: connection.id, matchId: state.matchId, serverTime: Date.now() }));
  }

  onClose(connection: Connection, _code: number, _reason: string, _wasClean: boolean) {
    const state = connection.state as PlayerState | null;

    if (state?.status === "matched" && state.peerId && state.clientId && state.peerClientId && state.matchId && state.side) {
      const opponent = this.getConnection(state.peerId);
      if (opponent) {
        const pending: PendingReconnect = {
          matchId: state.matchId,
          side: state.side,
          clientId: state.clientId,
          peerClientId: state.peerClientId,
          appearance: state.appearance ?? null,
          expiresAt: Date.now() + this.reconnectGraceMs,
        };
        this.pendingReconnects.set(state.clientId, pending);
        opponent.send(JSON.stringify({ type: "opponent_reconnecting", graceMs: this.reconnectGraceMs }));

        pending.timer = setTimeout(() => {
          const current = this.pendingReconnects.get(state.clientId!);
          if (!current || current.matchId !== state.matchId) return;
          this.pendingReconnects.delete(state.clientId!);

          const liveOpponent = this.findByClientId(state.peerClientId);
          if (!liveOpponent) return;
          const os = liveOpponent.state as PlayerState | null;
          if (!os || os.matchId !== state.matchId || os.status !== "matched") return;

          liveOpponent.setState({ status: "idle", clientId: os.clientId, score: 0, appearance: os.appearance ?? null });
          liveOpponent.send(JSON.stringify({ type: "opponent_left" }));
        }, this.reconnectGraceMs);
      }
    }

    this.broadcastPresence(connection.id);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, game: "ZigGo Run: Astro Brawl", service: "online-1v1" });
    }
    return (await routePartykitRequest(request, { ...env })) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
