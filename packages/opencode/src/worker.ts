import { ServerProcess } from "@opencode/server/process";
import { Effect, Exit, Logger, Scope } from "effect";

export interface OpenCodeWorkerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly password: string;
  readonly database: string;
  readonly configDirectory: string;
  /** Trusted deployment configuration, never model-authored workspace configuration. */
  readonly configuration: string;
}

/** Runs the official native HTTP server; no application gateway or custom framing. */
export async function serve(options: OpenCodeWorkerOptions): Promise<{ close: () => Promise<void> }> {
  if (!options.password) throw new Error("OpenCode worker authentication is required");
  const scope = Effect.runSync(Scope.make());

  try {
    await Effect.runPromise(ServerProcess.start({
      app: { name: "camenae-opencode", version: "2.0.23" },
      hostname: options.hostname, port: options.port, password: options.password,
      database: { path: options.database },
      config: { directory: options.configDirectory, project: false, content: options.configuration },
      models: { fetch: false }, fs: { filewatcher: false, fff: false },
    }).pipe(Scope.provide(scope), Effect.provide(Logger.layer([]))));

    return { close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  } catch {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    throw new Error("OpenCode worker startup failed");
  }
}
