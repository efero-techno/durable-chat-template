import {
  type Connection,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";

type PlayerState = {
  status: "waiting" | "matched";
  peerId?: string;
  matchId?: string;
  side?: "A" | "B";
  score?: number;
};

export class Chat extends Server<Env> {
  static options = { hibernate: true };

  findWaiting(excludeId: string) {
    for (const c of this.getConnections()) {
      if (c.id === excludeId) continue;

      const state = c.state as PlayerState | null;

      if (!state || state.status === "waiting") {
        return c;
      }
    }

    return null;
  }

  pairPlayers(a: Connection, b: Connection) {
    const matchId = crypto.randomUUID();

    a.setState({
      status: "matched",
      peerId: b.id,
      matchId,
      side: "A",
      score: 0,
    });

    b.setState({
      status: "matched",
      peerId: a.id,
      matchId,
      side: "B",
      score: 0,
    });

    a.send(
      JSON.stringify({
        type: "matched",
        matchId,
        side: "A",
      }),
    );

    b.send(
      JSON.stringify({
        type: "matched",
        matchId,
        side: "B",
      }),
    );
  }

  tryMatch(connection: Connection) {
    const other = this.findWaiting(connection.id);

    if (!other) {
      connection.setState({
        status: "waiting",
        score: 0,
      });

      connection.send(
        JSON.stringify({
          type: "waiting",
        }),
      );

      return;
    }

    this.pairPlayers(other, connection);
  }

  onConnect(connection: Connection) {
    connection.setState({
      status: "waiting",
      score: 0,
    });

    this.tryMatch(connection);
  }

  onMessage(connection: Connection, message: WSMessage) {
    if (typeof message !== "string") return;
    if (message.length > 8192) return;

    let data: any;

    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === "ping") {
      connection.send(
        JSON.stringify({
          type: "pong",
          time: Date.now(),
        }),
      );
      return;
    }

    const state = connection.state as PlayerState | null;

    if (!state || state.status !== "matched" || !state.peerId) {
      connection.send(
        JSON.stringify({
          type: "waiting",
        }),
      );
      return;
    }

    const opponent = this.getConnection(state.peerId);

    if (!opponent) {
      connection.setState({
        status: "waiting",
        score: 0,
      });

      this.tryMatch(connection);
      return;
    }

    opponent.send(
      JSON.stringify({
        ...data,
        from: connection.id,
        matchId: state.matchId,
        serverTime: Date.now(),
      }),
    );
  }

  onClose(
    connection: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ) {
    const state = connection.state as PlayerState | null;

    if (!state?.peerId) return;

    const opponent = this.getConnection(state.peerId);

    if (!opponent) return;

    opponent.setState({
      status: "waiting",
      score: 0,
    });

    opponent.send(
      JSON.stringify({
        type: "opponent_left",
      }),
    );

    this.tryMatch(opponent);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        game: "ZigGo Run: Astro Brawl",
        service: "online-1v1",
      });
    }

    return (
      (await routePartykitRequest(request, { ...env })) ||
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
