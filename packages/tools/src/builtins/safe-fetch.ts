import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

// Fetching URLs on behalf of an agent, from the app process, until browsing
// moves into the sandbox (M3). The danger is server-side request forgery: a
// page or a prompt steering the agent at 127.0.0.1, the Docker network, the
// router, or a cloud metadata address. Addresses are checked when the socket
// connects (the `lookup` hook), so DNS rebinding between check and use does
// not get through. Every redirect is checked the same way.

export class FetchBlockedError extends Error {
  readonly code = "blocked_url";
}

/** Loopback, private, link-local, CGNAT, multicast, reserved and the like. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6 === "::" || v6 === "::1") return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

function guardedLookup(
  hostname: string,
  options: object,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, []);
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked) {
      return callback(new FetchBlockedError(`${hostname} points to a private address`), []);
    }
    const all = (options as { all?: boolean }).all;
    if (all) return callback(null, addresses);
    const first = addresses[0];
    if (!first) return callback(new Error(`No address for ${hostname}`), []);
    callback(null, first.address, first.family);
  });
}

export interface SafeResponse {
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly truncated: boolean;
}

export interface SafeFetchOptions {
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

function once(
  url: URL,
  options: Required<SafeFetchOptions>,
): Promise<{ res: IncomingMessage; body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        timeout: options.timeoutMs,
        headers: {
          "user-agent": "One-for-All agent (+https://github.com/one-for-all)",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size > options.maxBytes) {
            truncated = true;
            chunks.push(chunk.subarray(0, chunk.length - (size - options.maxBytes)));
            res.destroy();
            resolve({ res, body: Buffer.concat(chunks), truncated });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ res, body: Buffer.concat(chunks), truncated }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () =>
      req.destroy(
        Object.assign(new Error("The page took too long to respond"), { code: "timeout" }),
      ),
    );
    req.on("error", reject);
    req.end();
  });
}

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const options = {
    maxBytes: opts.maxBytes ?? 2_000_000,
    timeoutMs: opts.timeoutMs ?? 15_000,
    maxRedirects: opts.maxRedirects ?? 5,
  };
  let url = new URL(input);
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new FetchBlockedError(`Only http and https URLs can be read (got ${url.protocol})`);
    }
    if (url.username || url.password)
      throw new FetchBlockedError("URLs with credentials are not allowed");
    // A literal IP skips DNS, so check it here.
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isPrivateAddress(host))
      throw new FetchBlockedError(`${host} is a private address`);

    const { res, body, truncated } = await once(url, options);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;
    if (status >= 300 && status < 400 && location) {
      if (hop >= options.maxRedirects) throw new Error("Too many redirects");
      url = new URL(location, url);
      continue;
    }
    return {
      url: url.toString(),
      status,
      contentType: String(res.headers["content-type"] ?? ""),
      body: body.toString("utf8"),
      truncated,
    };
  }
}
