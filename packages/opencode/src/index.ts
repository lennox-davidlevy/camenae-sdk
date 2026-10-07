import { OpenCode as Native, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client";

export type { OpenCodeEvent } from "@opencode/client";

export interface OpenCodeOptions {
  readonly baseUrl: string;
  readonly password: string;
  readonly workspace: string;
  readonly model: { readonly providerID: string; readonly id: string };
}

interface PendingRun {
  readonly sessionID: string;
  cancelled: boolean;
  admission?: Promise<void>;
}

/** A lost event stream is terminal: reconnecting must never replay a prompt. */
export class OpenCodeConnection {
  readonly native: OpenCodeClient;
  readonly #options: OpenCodeOptions;
  readonly #abort = new AbortController();
  readonly #listeners = new Set<(event: OpenCodeEvent) => void>();
  readonly #disconnections = new Set<() => void>();
  #pump: Promise<void> = Promise.resolve();
  #run: PendingRun | undefined;
  #closed = false;
  #failure: Error | undefined;
  #rejectRun: ((error: Error) => void) | undefined;

  private constructor(options: OpenCodeOptions) {
    this.#options = options;
    this.native = Native.make({
      baseUrl: options.baseUrl,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}` },
    });
  }

  static async connect(options: OpenCodeOptions): Promise<OpenCodeConnection> {
    if (!options.password || !options.workspace.startsWith("/")) throw new Error("Invalid OpenCode connection options");
    const connection = new OpenCodeConnection(options);
    const timeout = setTimeout(() => connection.#abort.abort(), 15_000);

    try {
      const info = await connection.native.server.info({ signal: connection.#abort.signal });

      if (info.version !== "2.0.23") throw new Error("Unsupported OpenCode server version");
      await new Promise<void>((resolve, reject) => {
        connection.#pump = (async () => {
          try {
            for await (const event of connection.native.event.subscribe({ signal: connection.#abort.signal })) {
              if (event.type === "server.connected") resolve();

              for (const listener of connection.#listeners) listener(event);
            }

            if (!connection.#closed) throw new Error("OpenCode event stream ended");
          } catch {
            connection.#failure = new Error("OpenCode connection lost");
            connection.#rejectRun?.(connection.#failure);

            if (!connection.#closed) for (const listener of connection.#disconnections) listener();

            reject(connection.#failure);
          }
        })();
      });

      return connection;
    } catch {
      await connection.close();
      throw new Error("OpenCode connection unavailable");
    } finally { clearTimeout(timeout); }
  }

  subscribe(listener: (event: OpenCodeEvent) => void): () => void {
    this.#listeners.add(listener);

    return () => { this.#listeners.delete(listener); };
  }

  get healthy(): boolean {
    return !this.#closed && !this.#failure;
  }

  onDisconnect(listener: () => void): () => void {
    this.#disconnections.add(listener);

    return () => { this.#disconnections.delete(listener); };
  }

  async openSession(id?: string): Promise<string> {
    this.#check();

    const session = id
      ? await this.native.session.get({ sessionID: id })
      : await this.native.session.create({
        location: { directory: this.#options.workspace }, model: this.#options.model,
        // Saved project grants are checked separately: native ordering gives them priority.
        permissions: [{ action: "*", resource: "*", effect: "ask" }],
      });

    if (session.location.directory !== this.#options.workspace) throw new Error("OpenCode session workspace mismatch");
    const saved = await this.native.permission.saved.list({ projectID: session.projectID });

    if (saved.length) throw new Error("OpenCode saved approvals require a separate policy decision");

    return session.id;
  }

  async run(sessionID: string, text: string): Promise<"completed" | "cancelled"> {
    this.#check();

    if (this.#run) throw new Error("OpenCode connection is busy");
    const pending: PendingRun = { sessionID, cancelled: false };
    this.#run = pending;

    const failure = new Promise<never>((_resolve, reject) => { this.#rejectRun = reject; });
    let finish: (() => void) | undefined;

    const drained = new Promise<void>((resolve) => { finish = resolve; });

    const unsubscribe = this.subscribe((event) => {
      if ((event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") && event.data.sessionID === sessionID) finish?.();
    });

    try {
      return await Promise.race([failure, (async () => {
        await this.openSession(sessionID);

        if (pending.cancelled) return "cancelled";
        pending.admission = this.native.session.prompt({ sessionID, text }, { signal: this.#abort.signal }).then(() => {});
        await pending.admission;
        await this.native.session.wait({ sessionID }, { signal: this.#abort.signal });
        // HTTP completion alone does not establish delivery of preceding stream events.
        await drained;
        const session = await this.native.session.get({ sessionID }, { signal: this.#abort.signal });

        if (session.outcome === "interrupted") return "cancelled";

        if (session.outcome !== "succeeded") throw new Error("OpenCode execution failed");

        return "completed";
      })()]);
    } finally {
      unsubscribe();
      this.#run = undefined;
      this.#rejectRun = undefined;
    }
  }

  async cancel(sessionID: string): Promise<void> {
    this.#check();
    const pending = this.#run;

    if (pending?.sessionID === sessionID) {
      pending.cancelled = true;

      if (!pending.admission) return;
      await pending.admission;
    }

    await this.native.session.interrupt({ sessionID, resume: false }, { signal: this.#abort.signal });
    await this.native.session.wait({ sessionID }, { signal: this.#abort.signal });
  }

  async approve(sessionID: string, requestID: string, decision: "once" | "reject"): Promise<void> {
    this.#check();
    await this.native.permission.reply({ sessionID, requestID, decision }, { signal: this.#abort.signal });
  }

  /** Ends observation only. The application must separately retire the execution lifetime. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#rejectRun?.(new Error("OpenCode connection closed"));
    this.#abort.abort();
    await this.#pump;
    this.#listeners.clear();
    this.#disconnections.clear();
  }

  #check(): void {
    if (this.#closed || this.#failure) throw new Error("OpenCode connection unavailable");
  }
}

export const OpenCode = { connect: OpenCodeConnection.connect };
