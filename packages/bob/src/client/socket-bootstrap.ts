import type { Socket } from "node:net";

const MAX_BOOTSTRAP_BYTES = 16 * 1024;

/** Private bootstrap only. ACP framing remains entirely in the official SDK. */
export function readBootstrap(socket: Socket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => fail(), 5_000);

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener("data", data);
      socket.removeListener("error", fail);
      socket.removeListener("close", fail);
      socket.removeListener("end", fail);
    };

    const fail = () => {
      cleanup();
      reject(new Error("Socket bootstrap failed"));
    };

    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(10);
      const prefix = newline === -1 ? chunk : chunk.subarray(0, newline);

      if (pending.length + prefix.length > MAX_BOOTSTRAP_BYTES) return fail();
      pending = Buffer.concat([pending, prefix]);

      if (newline === -1) return;
      socket.pause();
      cleanup();
      const remainder = chunk.subarray(newline + 1);

      if (remainder.length > 0) socket.unshift(remainder);
      resolve(pending);
    };

    socket.on("data", data);
    socket.once("error", fail);
    socket.once("close", fail);
    socket.once("end", fail);
    socket.resume();
  });
}
