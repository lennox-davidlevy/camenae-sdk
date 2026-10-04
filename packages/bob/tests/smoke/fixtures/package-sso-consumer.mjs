import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Bob } from "@camenae/bob";

// Real installed Bob owns the auth flow. Only the external login/token service
// and OS browser opener are synthetic; no bundle patch or SDK test hook.
const parent = process.env.BOB_GATEWAY_SMOKE_ROOT ?? resolve(".tmp");

mkdirSync(parent, { recursive: true });

const root = mkdtempSync(join(parent, "sso-"));

const workspace = join(root, "workspace"), home = join(root, "home"), otherHome = join(root, "other"), bin = join(root, "bin");

for (const path of [workspace, bin, home, otherHome]) mkdirSync(path, { mode: 0o700 });

for (const path of [home, otherHome]) {
  mkdirSync(join(path, ".bob/settings"), { recursive: true });
  writeFileSync(join(path, ".bob/settings/settings.json"), JSON.stringify({ telemetry: { enabled: false }, bobShell: { autoUpdate: false } }));
}

const original = { BOB_API_KEY: process.env.BOB_API_KEY, BOBSHELL_API_KEY: process.env.BOBSHELL_API_KEY, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };

process.env.BOB_API_KEY = "synthetic-parent-key";

process.env.BOBSHELL_API_KEY = "synthetic-different-alias";

process.env.XDG_CONFIG_HOME = join(root, "gateway-config");

mkdirSync(join(process.env.XDG_CONFIG_HOME, "bob-gateway"), { recursive: true, mode: 0o700 });

writeFileSync(join(process.env.XDG_CONFIG_HOME, "bob-gateway/config.json"), JSON.stringify({ apiKey: "synthetic-config-key" }), { mode: 0o600 });

let mode = "success", callback, logins = 0, exchanges = 0, refreshes = 0;

let gateway, worker, controller;

const token = () => ["eyJhbGciOiJub25lIn0", Buffer.from(JSON.stringify({ user: "synthetic-user", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url"), "synthetic"].join(".");

const failures = [];

const server = createServer((req, res) => {
  void handle(req, res).catch((error) => { failures.push(error); res.writeHead(500); res.end(); });
});

async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const chunks = [];

 for await (const chunk of req) chunks.push(chunk);

  if (url.pathname === "/login") {
    logins++;
    callback = new URL(url.searchParams.get("callback_uri"));
    assert.equal(callback.hostname, "127.0.0.1");
    assert.equal(callback.pathname, "/bob-callback");
    callback.searchParams.set("state", mode === "invalid-state" ? "wrong" : url.searchParams.get("state"));

    if (mode === "denied") callback.searchParams.set("error", "synthetic_denied");
    else callback.searchParams.set("code", "synthetic-code");

    if (mode !== "pending") await fetch(callback);
    res.end("synthetic login");
  } else if (url.pathname === "/authn/v1/auth/token" || url.pathname === "/authn/v1/auth/refresh") {
    const refreshing = url.pathname.endsWith("refresh");

    if (refreshing) refreshes++; else exchanges++;
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)), refreshing ? { refresh_token: "synthetic-refresh" } : { code: "synthetic-code" });

    if (mode === "expired" || mode === "exchange-failure") { res.writeHead(401); res.end("synthetic rejection");

 return; }

    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: token(), refresh_token: "synthetic-refresh" }));
  } else { res.writeHead(404); res.end("{}"); }
}

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

const base = `http://127.0.0.1:${server.address().port}`;

// macOS is the characterized platform. Do not launch a real browser on other OSes.
writeFileSync(join(bin, "open"), `#!${process.execPath}\nconst url=new URL(process.argv.at(-1));if(url.origin!==${JSON.stringify(base)})process.exit(1);fetch(url).then(r=>{if(!r.ok)process.exitCode=1}).catch(()=>{process.exitCode=1});\n`, { mode: 0o700 });

function environment(stateHome = home) {
  return { HOME: stateHome, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    XDG_CONFIG_HOME: join(stateHome, "config"), XDG_DATA_HOME: join(stateHome, "data"), XDG_CACHE_HOME: join(stateHome, "cache"), XDG_RUNTIME_DIR: stateHome,
    TMPDIR: root, TMP: root, TEMP: root, BOB_GATEWAY_URL: base, BOB_WEB_LOGIN_URL: base,
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined,
  };
}

async function start(remote = false, stateHome = home, overrides = {}) {
  const env = { ...environment(stateHome), ...overrides };

  if (remote) {
    const socketPath = join(root, "s");
    controller = new AbortController();
    worker = Bob.serveOnce({ socketPath, workspace, environment: env, signal: controller.signal, disableMcp: true, disableSubagents: true });
    void worker.catch(() => {});
    await until(() => existsSync(socketPath));
    gateway = await Bob.connect({ socketPath, workspace, credential: { kind: "sso" } });
  } else gateway = await Bob.start({ workspace, credential: { kind: "sso" }, environment: env, disableMcp: true, disableSubagents: true });
  assert.equal(gateway.initializeResult.agentInfo.version, "2.0.5");
  assert.ok(gateway.initializeResult.authMethods.some((method) => method.id === "sso"));
  assert.equal(process.env.BOBSHELL_API_KEY, "synthetic-different-alias");

  return gateway;
}

async function stop() {
  try {
    if (gateway) await ("disconnect" in gateway ? gateway.disconnect() : gateway.close());
  } finally {
    gateway = undefined;
    controller?.abort();

    try { await worker; } finally { worker = undefined; controller = undefined; }
  }
}

async function until(predicate) {
  const deadline = Date.now() + 10_000;

  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), "Synthetic login or worker did not become ready");
}

async function awaitWorkerExit() {
  let timer;

  try {
    await Promise.race([worker, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Worker did not exit after disconnect")), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

const authPath = join(home, ".bob/settings/auth-secrets.json");

function expire() {
  const store = JSON.parse(readFileSync(authPath, "utf8")), key = `bob.auth.tokens-${base}`;
  const stored = JSON.parse(store[key]);
  stored.expiresAt = 1; store[key] = JSON.stringify(stored);
  writeFileSync(authPath, JSON.stringify(store));
}

try {
  await start();
  await assert.rejects(gateway.newSession(), { code: -32000 });
  assert.equal(logins, 0, "Startup must not launch login");
  await stop();
  // No child key and no parent key: Gateway user config must still be bypassed.
  delete process.env.BOB_API_KEY;
  await start(false, home, { BOB_API_KEY: undefined, BOBSHELL_API_KEY: undefined });
  await assert.rejects(gateway.newSession(), { code: -32000 });
  await stop();
  process.env.BOB_API_KEY = "synthetic-parent-key";

  if (process.platform === "darwin") {
    await start();
    await assert.rejects(gateway.authenticate({ methodId: "unknown" }), { code: -32602 });
    await gateway.authenticate({ methodId: "sso" });
    assert.equal(logins, 1); assert.equal(exchanges, 1);
    assert.ok((await gateway.newSession()).sessionId);
    const persisted = readFileSync(authPath, "utf8");
    await stop();
    assert.equal(readFileSync(authPath, "utf8"), persisted, "Close is not logout");

    await start(true); // Replacement worker reuses only its supplied Bob HOME.
    await gateway.authenticate({ methodId: "sso" });
    assert.equal(logins, 1);
    assert.ok((await gateway.newSession()).sessionId);
    await stop();
    await start(true, otherHome);
    await assert.rejects(gateway.newSession(), { code: -32000 });
    assert.equal(logins, 1);
    await stop();

    expire();
    await start(true);
    await gateway.authenticate({ methodId: "sso" });
    assert.ok(refreshes > 0); assert.equal(logins, 1);
    await stop();
    expire(); mode = "expired";
    await start();
    await assert.rejects(gateway.newSession(), { code: -32000 });
    await stop();

    for (const failure of ["invalid-state", "denied", "exchange-failure"]) {
      mode = failure;
      await start();
      const before = exchanges;
      await assert.rejects(gateway.authenticate({ methodId: "sso" }));
      assert.equal(exchanges, before + (failure === "exchange-failure" ? 1 : 0));
      await assert.rejects(gateway.newSession(), { code: -32000 });
      await stop();
    }

    // Exercise actual SDK interruption, including worker-side owned-process cleanup.
    for (const ending of ["abort", "timeout", "close", "disconnect"]) {
      mode = "pending"; callback = undefined;
      await start(ending === "disconnect");
      const cancellation = new AbortController();
      const auth = gateway.authenticate({ methodId: "sso" }, { signal: cancellation.signal, timeoutMs: ending === "timeout" ? 2_000 : 20_000 });
      const result = auth.then(() => undefined, (error) => error);
      await until(() => callback !== undefined);

      if (ending === "abort") cancellation.abort();

      if (ending === "close") await gateway.close();

      if (ending === "disconnect") {
        await gateway.disconnect();
        // EOF must drive cleanup; aborting the worker here would mask a defect.
        await awaitWorkerExit();
      }

      const error = await result;
      assert.ok(error, "Interrupted login must reject");

      if (ending === "abort" || ending === "timeout") {
        assert.equal(error.code, ending === "abort" ? "cancelled" : "timeout");
        await assert.rejects(gateway.newSession());
      }

      // Assert before fallback cleanup: abort/timeout must already have completed
      // local teardown, and remote EOF must have settled serveOnce independently.
      await assert.rejects(fetch(callback), "Login listener survived owned-process cleanup");
      await stop();
    }

    mode = "success";
    await start(true);
    await gateway.authenticate({ methodId: "sso" });
    assert.ok((await gateway.newSession()).sessionId);
    await stop();
    console.log("Installed native SSO passed: explicit selection, login, callback errors, persistence, refresh/re-login, isolated state, worker replacement, and interrupted-login cleanup.");
  } else console.log("Installed keyless SSO selection passed; interactive synthetic browser flow remains macOS-only validation.");
  assert.deepEqual(failures, []);
} finally {
  await stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));

  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }

  rmSync(root, { recursive: true, force: true });
}
