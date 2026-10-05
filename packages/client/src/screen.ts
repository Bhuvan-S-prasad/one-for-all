import { screenMessageSchema, type ScreenInputMessage, type ScreenMessage } from "@ofa/contracts";

// A person's view of an agent's browser (M3.07): frames in, and in control
// mode, mouse and keyboard out. One socket per view; no reconnecting, since a
// dropped control session must end the takeover.

export interface ScreenConnection {
  send(input: ScreenInputMessage): void;
  close(): void;
}

export function connectScreen(options: {
  /** `ws(s)://host/api/agents/<id>/screen`, plus `?control=1` to take over. */
  readonly url: string;
  readonly onMessage: (message: ScreenMessage) => void;
  readonly onClose: () => void;
}): ScreenConnection {
  const socket = new WebSocket(options.url);
  socket.onmessage = (event) => {
    const parsed = screenMessageSchema.safeParse(JSON.parse(String(event.data)));
    if (parsed.success) options.onMessage(parsed.data);
  };
  socket.onclose = () => options.onClose();
  return {
    send(input) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input));
    },
    close() {
      socket.close();
    },
  };
}
