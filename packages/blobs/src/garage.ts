// Garage's one-time setup (ADR-0047), through its admin API (v2): a fresh
// node has no layout, no key and no bucket. On every start the app makes sure
// of all three; each step is skipped when it is already done. Checked against
// Garage v2.4.1.

export interface GarageSetupOptions {
  /** `http://127.0.0.1:3903` in dev, `http://garage:3903` in the bundle. */
  readonly adminUrl: string;
  readonly adminToken: string;
  readonly bucket: string;
  /** The S3 key the app uses, imported into Garage (`GK` and 24 hex digits). */
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Space Garage may use on this node; the layout needs a number. */
  readonly capacityBytes?: number;
  /** For tests. */
  readonly fetch?: typeof fetch;
}

export async function setUpGarage(options: GarageSetupOptions): Promise<void> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const call = async <T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T | null> => {
    const response = await doFetch(`${options.adminUrl.replace(/\/+$/, "")}/v2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.adminToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`Garage admin ${path}: HTTP ${response.status} ${detail}`.trim());
    }
    return (await response.json()) as T;
  };

  // 1. A layout with this node in it.
  const status = await call<{ nodes: { id: string; role?: unknown }[] }>("GET", "GetClusterStatus");
  const node = status?.nodes[0];
  if (!node) throw new Error("Garage reports no node");
  const layout = await call<{ version: number; roles: { id: string }[] }>(
    "GET",
    "GetClusterLayout",
  );
  if (!layout) throw new Error("Garage has no layout");
  if (!layout.roles.some((role) => role.id === node.id)) {
    await call("POST", "UpdateClusterLayout", {
      roles: [
        {
          id: node.id,
          zone: "local",
          capacity: options.capacityBytes ?? 100_000_000_000,
          tags: [],
        },
      ],
    });
    await call("POST", "ApplyClusterLayout", { version: layout.version + 1 });
  }

  // 2. The app's key.
  const key = await call("GET", `GetKeyInfo?id=${encodeURIComponent(options.accessKeyId)}`);
  if (!key) {
    await call("POST", "ImportKey", {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      name: "one-for-all",
    });
  }

  // 3. The bucket, and the key allowed on it.
  let bucket = await call<{ id: string }>(
    "GET",
    `GetBucketInfo?globalAlias=${encodeURIComponent(options.bucket)}`,
  );
  bucket ??= await call<{ id: string }>("POST", "CreateBucket", { globalAlias: options.bucket });
  if (!bucket) throw new Error(`Garage didn't create the bucket ${options.bucket}`);
  await call("POST", "AllowBucketKey", {
    bucketId: bucket.id,
    accessKeyId: options.accessKeyId,
    permissions: { read: true, write: true, owner: false },
  });
}
