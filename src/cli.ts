/**
 * Command-line entry shared by the worker and the recipes.
 *
 *   (no flags)                       stdio: what DuckDB launches by default
 *   --unix PATH                      AF_UNIX socket (DuckDB's `launch:` LOCATION adds this)
 *   --http [--host H] [--port N]     HTTP; prints `PORT:<n>` on stdout once listening
 *   --debug | --log-level LEVEL      log verbosity (stderr)
 *
 * The SDK's `Worker.run()` handles stdio and `--unix`; HTTP is served by the
 * SDK's `serveVgiWorker`, which also answers `GET /health`.
 */

import { type CatalogDescriptor, FunctionRegistry, ReadOnlyCatalogInterface, Worker } from "@query-farm/vgi";
import { serveVgiWorker } from "@query-farm/vgi/serve";
import { log, parseLevel, setLogLevel } from "./log.ts";

const HELP = `usage: <worker> [--http [--host HOST] [--port PORT]] [--unix PATH] [--debug | --log-level LEVEL]

  (no flags)        serve over stdin/stdout (what DuckDB launches)
  --http            serve over HTTP; prints PORT:<n> on stdout once listening
  --host HOST       HTTP bind address (default 127.0.0.1)
  --port PORT       HTTP port, 0 for any free port (default $PORT or 8000)
  --unix PATH       serve on an AF_UNIX socket (DuckDB's launch: transport)
  --debug           shorthand for --log-level debug
  --log-level L     debug | info | warn | error (default info)
`;

export interface ServeOptions {
  /** Version shown on the HTTP landing page. */
  version: string;
  /** One-line description shown on the HTTP landing page. */
  doc: string;
  /** Source repository linked from the HTTP landing page. */
  repositoryUrl?: string;
}

interface HttpArgs {
  http: boolean;
  host: string;
  port: number;
  /** Everything the SDK should see (stdio / --unix flags). */
  rest: string[];
}

function parseArgs(argv: readonly string[]): HttpArgs {
  const out: HttpArgs = { http: false, host: "127.0.0.1", port: Number(process.env.PORT ?? 8000), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const [flag, inline] = arg.startsWith("--") && arg.includes("=") ? arg.split("=", 2) : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    switch (flag) {
      case "-h":
      case "--help":
        process.stderr.write(HELP);
        process.exit(0);
        break;
      case "--http":
        out.http = true;
        break;
      case "--host":
        out.host = value();
        break;
      case "--port":
        out.port = Number(value());
        break;
      case "--debug":
        setLogLevel("debug");
        process.env.VGI_DEBUG = "1";
        break;
      case "--log-level": {
        const level = parseLevel(value());
        if (!level) throw new Error("--log-level must be debug, info, warn or error");
        setLogLevel(level);
        if (level === "debug") process.env.VGI_DEBUG = "1";
        break;
      }
      default:
        out.rest.push(arg);
    }
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) {
    throw new Error(`invalid port: ${out.port}`);
  }
  return out;
}

/** Serve `catalog` over the transport selected by `argv`. */
export function serve(
  catalog: CatalogDescriptor,
  options: ServeOptions,
  argv: readonly string[] = process.argv.slice(2),
): void {
  let args: HttpArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  // One registry for every transport: the catalog records which schema owns
  // each function on it, and schema-qualified calls resolve through it.
  const registry = new FunctionRegistry();
  for (const schema of catalog.schemas) {
    for (const fn of schema.functions ?? []) registry.register(fn);
  }
  const catalogInterface = new ReadOnlyCatalogInterface(catalog, registry);

  if (!args.http) {
    log.debug(`serving catalog ${catalog.name} (${args.rest.includes("--unix") ? "unix socket" : "stdio"})`);
    new Worker({ registry, catalogInterface }).run(args.rest);
    return;
  }

  const server = serveVgiWorker({
    name: catalog.name,
    doc: options.doc,
    version: options.version,
    repositoryUrl: options.repositoryUrl,
    registry,
    catalogInterface,
    hostname: args.host,
    port: args.port,
    quiet: true,
    argv: args.rest,
  });
  // The one line HTTP mode prints on stdout: test harnesses and process
  // managers read the bound port from it.
  process.stdout.write(`PORT:${server.port}\n`);
  log.info(`serving catalog ${catalog.name} on http://${args.host}:${server.port} (health: /health)`);
}
