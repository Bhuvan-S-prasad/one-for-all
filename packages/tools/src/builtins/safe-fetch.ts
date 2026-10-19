import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

// Fetching URLs on behalf of an agent, from the app process, until browsing
// moves into the sandbox (M3). The danger is server-side request forgery: a
// page or a prompt steering the agent at 127.0.0.1, the Docker network, the
// router, or a cloud metadata address. Addresses are checked when the socket
// connects (the `lookup` hook), so DNS rebinding between check and use does
// not get through. Every redirect is checked the same way.

export class FetchBlockedError extends Error {
  readonly code = "blocked_url";
}

// The same ranges as the sandbox's egress proxy (infra/docker/sandbox/egress.mjs).
const PRIVATE_V4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 16],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_V4.addSubnet(net, prefix, "ipv4");
}
const PRIVATE_V6 = new BlockList();
for (const [net, prefix] of [
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
] as const) {
  PRIVATE_V6.addSubnet(net, prefix, "ipv6");
}

/** The eight 16-bit groups of a valid IPv6 address, with any dotted tail folded in. */
function ipv6Groups(address: string): number[] {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const gap = tail === undefined ? [] : Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...gap, ...back].map((group) => parseInt(group, 16));
}

/**
 * Loopback, private, link-local, CGNAT, multicast, reserved and the like.
 * An IPv6 address that carries an IPv4 one (mapped `::ffff:0:0/96` in any
 * spelling, compatible `::/96`, NAT64 `64:ff9b::/96`) is judged by that IPv4
 * address: the URL parser writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`.
 */
export function isPrivateAddress(address: string): boolean {
  const ip =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%")[0] ?? "";
  if (isIP(ip) === 4) return PRIVATE_V4.check(ip, "ipv4");
  if (isIP(ip) !== 6) return true;
  const g = ipv6Groups(ip);
  const embedded = `${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`;
  const zeros = (from: number, to: number) => g.slice(from, to).every((n) => n === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateAddress(embedded);
  return PRIVATE_V6.check(ip, "ipv6");
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
