import { log } from "../middleware/logger";
import { WebSocket } from "ws";
import { ClientManager } from "./ClientManager";

export class Client {
  private ws: WebSocket;
  private id: string;
  private apiKey: string;
  private lastSeen: number;
  private connectedSince: number; // Add this
  private connected: boolean;

  constructor(ws: WebSocket, id: string, apiKey: string) {
    this.ws = ws;
    this.id = id;
    this.apiKey = apiKey;
    this.lastSeen = Date.now();
    this.connectedSince = Date.now(); // Add this
    this.connected = true;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.ws.on("message", (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        log.info(`Received message from client ${this.id}: ${message.type}`);
        this.handleMessage(data);
      } catch (error) {
        log.error(`Error processing WebSocket message: ${error}`);
      }
    });

    this.ws.on("close", () => {
      this.connected = false;
      this.handleClose();
    });
  }

  private ping(): void {
    if (this.isAlive()) {
      try {
        this.ws.send(JSON.stringify({ type: "ping" }));
      } catch (err) {
        // Connection might be dead
        this.connected = false;
      }
    }
  }

  private handleMessage(data: Buffer): void {
    try {
      const message = JSON.parse(data.toString());
      this.updateLastSeen();

      // Handle ping messages directly without broadcasting
      if (message.type === "ping") {
        this.send({ type: "pong" });
        return;
      }
      
      // For all other messages
      ClientManager.handleIncomingMessage(this.id, message);
      
      // Only broadcast non-ping/pong messages
      if (message.type !== "pong") {
        this.broadcast(message);
      }
    } catch (error) {
      log.error("Error handling message", { error, clientId: this.id });
    }
  }

  private handleClose(): void {
    log.info("Client disconnected", { clientId: this.id });
    ClientManager.removeClient(this.id);
  }

  public send(data: unknown): boolean {
    if (!this.isAlive()) return false;
    
    try {
      this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
      return true;
    } catch (error) {
      log.error("Error sending message", { error, clientId: this.id });
      this.connected = false;
      return false;
    }
  }

  private broadcast(message: unknown): void {
    ClientManager.broadcastToGroup(this.id, message);
  }

  public getId(): string {
    return this.id;
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public updateLastSeen(): void {
    this.lastSeen = Date.now();
  }

  public getLastSeen(): number {
    return this.lastSeen;
  }

  public isAlive(): boolean {
    // Only check if the WebSocket connection is still open
    // This relies on the WebSocket protocol-level ping/pong mechanism to verify connection health
    // As long as the client is responding to protocol pings, we consider it alive
    return (this.connected && this.ws.readyState === WebSocket.OPEN);
  }

  public disconnect(): void {
    if (this.connected && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.close();
      } catch (error) {
        log.error("Error closing WebSocket", { error, clientId: this.id });
      }
    }
    this.connected = false;
  }

  public markDisconnected(): void {
    this.connected = false;
  }
}
