// callback_allowlist: comma-separated CIDRs (192.168.0.0/16), IPs, globs (*.example.internal) or hostnames.

export function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const ipv4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
};

function matchCidr(host: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const h = ipv4ToInt(host);
  const n = ipv4ToInt(net ?? "");
  const bits = Number(bitsRaw);
  if (h === null || n === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((h & mask) >>> 0) === ((n & mask) >>> 0);
}

function matchGlob(host: string, pattern: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^.]*") + "$");
  return re.test(host);
}

export function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowlist.some((entry) => {
    if (entry.includes("/")) return matchCidr(h, entry);
    if (entry.includes("*")) return matchGlob(h, entry);
    return h === entry;
  });
}

export function urlAllowed(url: string, allowlist: readonly string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return hostAllowed(u.hostname, allowlist);
  } catch {
    return false;
  }
}
