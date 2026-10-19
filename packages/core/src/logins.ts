// Saved logins (M3.08, ADR-0012): a site's password is typed into that site's
// own pages by a tool and never shown to an agent. Each lives in the vault as
// two secrets, the password alone (so it is redacted from all output) and the
// username beside it.

/** `https://Accounts.Example.com/login` or `example.com.` → `accounts.example.com`; null if not a site. */
export function normalizeLoginSite(input: string): string | null {
  // By hand: core uses no platform APIs (no URL).
  const text = input.trim().toLowerCase();
  // Only a web address names a site: `javascript://shop.example/…` or
  // `file://shop.example/…` is not shop.example, whatever follows the `//`.
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//.exec(text)?.[1];
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  const host = (
    text
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^[^@/]*@/, "")
      .split(/[/?#:]/)[0] ?? ""
  )
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    host,
  ) && host.length <= 80
    ? host
    : null;
}

export const LOGIN_SECRET_PREFIX = "login.";

export function loginSecretNames(site: string): {
  readonly username: string;
  readonly password: string;
} {
  return {
    username: `${LOGIN_SECRET_PREFIX}${site}.username`,
    password: `${LOGIN_SECRET_PREFIX}${site}.password`,
  };
}

/** The site of a login's password secret, or null for any other secret. */
export function loginSiteOf(secretName: string): string | null {
  const match = /^login\.(.+)\.password$/.exec(secretName);
  return match?.[1] ?? null;
}

/** Whether a page on `host` belongs to `site` (the site itself or a subdomain). */
export function hostMatchesSite(host: string, site: string): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return h === site || h.endsWith(`.${site}`);
}
