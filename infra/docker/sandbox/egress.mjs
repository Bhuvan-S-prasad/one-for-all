// The sandbox's only way out (M3.02). The sandbox sits on an internal Docker
// network with no route to the internet; this proxy, on both networks, is the
// one exit. Browsers and shell tools use it as their HTTP(S) proxy.
//
// Rules, for every request:
//   - only ports 80 and 443;
//   - the host must match EGRESS_ALLOW: comma-separated domains, each also
//     covering its subdomains, or "*" for any public host; empty denies all;
//   - every address the name resolves to must be public: never loopback, the
//     private ranges, link-local (cloud metadata), CGNAT or multicast, so the
//     sandbox cannot reach the app, the database or the home network;
//   - the connection goes to the address that was checked, so a DNS answer
//     cannot change between the check and the connect.
//
// EGRESS_FORWARD=<port>:<host>:<port>,... also forwards plain TCP from this
// container (on the default network) to the sandbox, which is how the app
// reaches the sandbox service without joining the sandbox network.
//
// No dependencies: Node built-ins only. Runs as an unprivileged user.

import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

const PORT = Number(process.env.EGRESS_PORT ?? 3128);
const ALLOW = (process.env.EGRESS_ALLOW ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, ""))
  .filter(Boolean);
const PORTS = new Set([80, 443]);
const CONNECT_TIMEOUT = 15_000;

const log = (msg, fields = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), msg, ...fields }));

// Same ranges as @ofa/tools `isPrivateAddress` (web.read_url).
const PRIVATE_V4 = new net.BlockList();
for (const [subnet, prefix] of [
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
]) {
  PRIVATE_V4.addSubnet(subnet, prefix, "ipv4");
}
const PRIVATE_V6 = new net.BlockList();
for (const [subnet, prefix] of [
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
  ["2002::", 16], // 6to4: embeds an IPv4 address
  ["64:ff9b:1::", 48], // local-use NAT64
]) {
  PRIVATE_V6.addSubnet(subnet, prefix, "ipv6");
}

/** The eight 16-bit groups of a valid IPv6 address, with any dotted tail folded in. */
function ipv6Groups(address) {
  let text = address;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const gap = tail === undefined ? [] : Array(8 - front.length - back.length).fill("0");
  return [...front, ...gap, ...back].map((group) => parseInt(group, 16));
}

/**
 * An IPv6 address that carries an IPv4 one (mapped `::ffff:0:0/96` in any
 * spelling, compatible `::/96`, NAT64 `64:ff9b::/96`) is judged by that IPv4
 * address: the URL parser writes `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`.
 */
export function isPrivateAddress(address) {
  const ip = address
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .split("%")[0];
  if (net.isIPv4(ip)) return PRIVATE_V4.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return true;
  const g = ipv6Groups(ip);
  const embedded = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  const zeros = (from, to) => g.slice(from, to).every((n) => n === 0);
  if (zeros(0, 5) && (g[5] === 0xffff || g[5] === 0)) return isPrivateAddress(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateAddress(embedded);
  return PRIVATE_V6.check(ip, "ipv6");
}

export function hostAllowed(host, allow = ALLOW) {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((rule) => rule === "*" || name === rule || name.endsWith(`.${rule}`));
}

/** The address to connect to, or why the request is refused. */
async function resolve(host, port) {
  if (!PORTS.has(port)) return { error: `port ${port} is not allowed` };
  if (!hostAllowed(host)) return { error: `${host} is not on the sandbox's allowed list` };
  let addresses;
  try {
    addresses = net.isIP(host.replace(/^\[|\]$/g, ""))
      ? [{ address: host.replace(/^\[|\]$/g, "") }]
      : await dns.lookup(host, { all: true });
  } catch {
    return { error: `${host} could not be found` };
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    return { error: `${host} points to a private address` };
  }
  return { address: addresses[0].address };
}

function refuse(res, host, reason) {
  log("blocked", { host, reason });
  res.writeHead(403, { "content-type": "text/plain" });
  res.end(`Blocked by the sandbox: ${reason}.\n`);
}

const proxy = http.createServer(async (req, res) => {
  // Plain HTTP: absolute-form request targets, e.g. `GET http://example.com/`.
  let target;
  try {
    target = new URL(req.url ?? "");
  } catch {
    return refuse(res, "?", "not a proxy request");
  }
  if (target.protocol !== "http:") return refuse(res, target.hostname, "only http here");
  const port = Number(target.port || 80);
  const checked = await resolve(target.hostname, port);
  if (checked.error) return refuse(res, target.hostname, checked.error);
  log("allowed", { host: target.hostname, port });
  const headers = { ...req.headers, host: target.host };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const upstream = http.request(
    {
      host: checked.address,
      port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: CONNECT_TIMEOUT,
    },
    (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("The site did not answer.\n");
  });
  req.pipe(upstream);
});

// HTTPS: CONNECT host:443, then raw bytes both ways (TLS stays end to end).
proxy.on("connect", async (req, socket, head) => {
  const [host, rawPort] = splitHostPort(req.url ?? "");
  const port = Number(rawPort);
  const checked = await resolve(host, port);
  if (checked.error) {
    log("blocked", { host, reason: checked.error });
    socket.end(
      `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by the sandbox: ${checked.error}.\n`,
    );
    return;
  }
  log("allowed", { host, port });
  const upstream = net.connect({ host: checked.address, port, timeout: CONNECT_TIMEOUT }, () => {
    upstream.setTimeout(0);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("timeout", close);
  upstream.on("error", () => {
    if (socket.writable) socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    close();
  });
  socket.on("error", close);
});

function splitHostPort(value) {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (ipv6) return [ipv6[1], ipv6[2]];
  const at = value.lastIndexOf(":");
  return at > 0 ? [value.slice(0, at), value.slice(at + 1)] : [value, "443"];
}

// Plain TCP forwards (the app → the sandbox service).
for (const rule of (process.env.EGRESS_FORWARD ?? "").split(",").filter(Boolean)) {
  const [listen, host, port] = rule.split(":");
  net
    .createServer((client) => {
      const upstream = net.connect(Number(port), host);
      client.pipe(upstream);
      upstream.pipe(client);
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      client.on("error", close);
      upstream.on("error", close);
    })
    .listen(Number(listen), "0.0.0.0", () => log("forwarding", { listen, to: `${host}:${port}` }));
}

if (process.argv[1]?.endsWith("egress.mjs")) {
  proxy.listen(PORT, "0.0.0.0", () =>
    log("egress proxy ready", { port: PORT, allow: ALLOW.length ? ALLOW : "nothing" }),
  );
}
