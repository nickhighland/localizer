'use strict';

/**
 * Container discovery: reads Docker's own view of this host, turns every
 * container that advertises a web UI into a proposed service, and compares that
 * with what is already configured.
 *
 * Unraid stamps each container it manages with `net.unraid.docker.webui` and
 * `net.unraid.docker.icon`, so no template parsing is needed. The WebUI value
 * comes in two dialects that mean different things:
 *
 *   http://[IP]:[PORT:8080]/    8080 is the CONTAINER port; Unraid substitutes
 *                               whichever host port publishes it.
 *   http://192.168.1.50:8989    a literal address, so 8989 is the HOST port.
 *
 * Reading those the wrong way round is not academic: a container can publish
 * 8184->8084 and 8384->8184 at the same time, and only one reading reaches the
 * web UI.
 */

const os = require('os');
const docker = require('./docker');
const categories = require('./categories');
const { normalizeService, HOSTNAME_RE } = require('./config');
const { normalizeIconUrl } = require('./icons');

const LABEL_WEBUI = 'net.unraid.docker.webui';
const LABEL_ICON = 'net.unraid.docker.icon';
const LAN_DRIVERS = new Set(['macvlan', 'ipvlan']);
const FALLBACK_GATEWAY = '172.17.0.1';

const lower = (value) => String(value || '').toLowerCase();

function containerName(container) {
  return String((container.Names && container.Names[0]) || '').replace(/^\//, '');
}

/** Reads a WebUI label into { scheme, kind: 'container' | 'host', port }. */
function parseWebUi(label) {
  const value = String(label || '').trim();
  if (!value) return null;
  const scheme = /^https:/i.test(value) ? 'https' : 'http';
  const defaultPort = scheme === 'https' ? 443 : 80;

  const placeholder = value.match(/\[PORT:(\d{1,5})\]/i);
  if (placeholder) return { scheme, kind: 'container', port: Number(placeholder[1]) };

  // "[IP]" with a literal port: only [PORT:n] gets substituted, so this is a host port.
  const ipWithPort = value.match(/^https?:\/\/\[IP\]:(\d{1,5})/i);
  if (ipWithPort) return { scheme, kind: 'host', port: Number(ipWithPort[1]) };

  if (/^https?:\/\/\[IP\](?:[/?#]|$)/i.test(value)) return { scheme, kind: 'container', port: defaultPort };

  const literal = value.match(/^https?:\/\/([^/:?#\s[\]]+)(?::(\d{1,5}))?/i);
  if (literal) return { scheme, kind: 'host', port: literal[2] ? Number(literal[2]) : defaultPort };

  return null;
}

function tcpBindings(ports) {
  const published = new Set();
  const containerToHost = new Map();
  for (const binding of ports || []) {
    if (binding.Type !== 'tcp' || !binding.PublicPort) continue;
    published.add(binding.PublicPort);
    // IPv4 and IPv6 bindings repeat the same pair; the first is enough.
    if (!containerToHost.has(binding.PrivatePort)) {
      containerToHost.set(binding.PrivatePort, binding.PublicPort);
    }
  }
  return { published, containerToHost };
}

/**
 * Where a container's web UI can be reached from inside Localizer — or, when it
 * cannot, a plain-English reason.
 */
function resolveTarget(container, ctx) {
  const webui = parseWebUi((container.Labels || {})[LABEL_WEBUI]);
  if (!webui) return { reason: 'No web UI is defined for this container.' };

  // Containers that borrow another's network stack (VPN sidecars) have their
  // ports published on that other container.
  let source = container;
  const mode = String(container.HostConfig?.NetworkMode || '');
  if (mode.startsWith('container:')) {
    const ref = mode.slice('container:'.length);
    source = ctx.containers.find((c) => String(c.Id || '').startsWith(ref) || containerName(c) === ref);
    if (!source) return { reason: 'It shares the network of a container that no longer exists.' };
  }

  // Host networking: no translation, and the host is reached via the gateway.
  if (String(source.HostConfig?.NetworkMode || '') === 'host') {
    return { scheme: webui.scheme, host: ctx.gateway, port: webui.port };
  }

  // macvlan/ipvlan (Unraid's br0): its own LAN address and no port mapping.
  const lan = Object.entries(source.NetworkSettings?.Networks || {})
    .find(([name, net]) => LAN_DRIVERS.has(ctx.drivers.get(name)) && net && net.IPAddress);
  if (lan) return { scheme: webui.scheme, host: lan[1].IPAddress, port: webui.port };

  const { published, containerToHost } = tcpBindings(source.Ports);
  if (!published.size && source.State && source.State !== 'running') {
    return { reason: 'It is not running, so Docker reports no ports. Start it and scan again.' };
  }

  const port = webui.kind === 'container'
    ? (containerToHost.get(webui.port) ?? (published.has(webui.port) ? webui.port : null))
    : (published.has(webui.port) ? webui.port : (containerToHost.get(webui.port) ?? null));

  if (!port) return { reason: `Port ${webui.port} is not published to the host.` };
  return { scheme: webui.scheme, host: ctx.gateway, port };
}

function isSelf(container, selfId) {
  if (selfId && String(container.Id || '').startsWith(selfId)) return true;
  return /(^|\/)(localizer|unraid-reverse-proxy)(:|@|$)/i.test(String(container.Image || ''));
}

/** Turns raw Docker API responses into one entry per container. Pure. */
function buildEntries(containers, networks, { selfId = null, hostAddress = null } = {}) {
  const drivers = new Map((networks || []).map((n) => [n.Name, n.Driver]));
  const bridge = (networks || []).find((n) => n.Name === 'bridge');
  const gateway = hostAddress
    || ((bridge && bridge.IPAM && bridge.IPAM.Config) || []).find((c) => c.Gateway)?.Gateway
    || FALLBACK_GATEWAY;

  const ctx = { containers: containers || [], drivers, gateway };
  const entries = [];
  for (const container of ctx.containers) {
    const name = containerName(container);
    if (!name || isSelf(container, selfId)) continue;
    const target = resolveTarget(container, ctx);
    const entry = {
      container: name,
      state: container.State || 'unknown',
      icon: normalizeIconUrl((container.Labels || {})[LABEL_ICON]) || '',
    };
    if (target.reason) entry.reason = target.reason;
    else Object.assign(entry, { scheme: target.scheme, host: target.host, port: target.port });
    entries.push(entry);
  }
  entries.sort((a, b) => a.container.localeCompare(b.container, undefined, { sensitivity: 'base' }));
  return { gateway, entries };
}

async function scan({ socketPath = docker.DEFAULT_SOCKET } = {}) {
  if (!docker.available(socketPath)) return { available: false, socket: socketPath };

  const [containers, networks] = await Promise.all([
    docker.get('/containers/json?all=1', { socketPath }),
    docker.get('/networks', { socketPath }),
  ]);

  // Docker sets a container's hostname to the first 12 characters of its id.
  const hostname = os.hostname();
  const built = buildEntries(containers, networks, {
    selfId: /^[0-9a-f]{12}$/.test(hostname) ? hostname : null,
    hostAddress: process.env.HOST_ADDRESS || null,
  });
  return { available: true, socket: socketPath, ...built };
}

/**
 * Decides which container each configured service belongs to: its stored
 * binding first, then an exact name match, then an unambiguous match on address
 * and port. Services matching nothing are left alone — they point at something
 * outside Docker, and discovery has no opinion about them.
 */
function computeBindings(cfg, entries) {
  const bindings = new Map();
  const claimed = new Set();
  const byName = new Map(entries.map((e) => [lower(e.container), e]));

  for (const service of cfg.services) {
    if (!service.container) continue;
    bindings.set(service.id, service.container);
    claimed.add(lower(service.container));
  }

  for (const service of cfg.services) {
    if (bindings.has(service.id)) continue;
    const entry = byName.get(lower(service.name));
    if (entry && !claimed.has(lower(entry.container))) {
      bindings.set(service.id, entry.container);
      claimed.add(lower(entry.container));
    }
  }

  for (const service of cfg.services) {
    if (bindings.has(service.id)) continue;
    const hits = entries.filter((e) => !e.reason && !claimed.has(lower(e.container))
      && e.host === service.host && e.port === service.port);
    if (hits.length === 1) {
      bindings.set(service.id, hits[0].container);
      claimed.add(lower(hits[0].container));
    }
  }
  return bindings;
}

/** Writes bindings onto services, so a later rename cannot sever them. */
function persistBindings(cfg, scanned) {
  const bindings = computeBindings(cfg, scanned.entries);
  let linked = 0;
  for (const service of cfg.services) {
    const ref = bindings.get(service.id);
    if (ref && service.container !== ref) {
      service.container = ref;
      linked += 1;
    }
  }
  return linked;
}

function slugify(name) {
  const slug = String(name || '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
  return slug || 'service';
}

function uniqueHostname(base, taken) {
  if (!taken.has(base) && HOSTNAME_RE.test(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!taken.has(candidate) && HOSTNAME_RE.test(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** What would change, without changing anything. */
function plan(cfg, scanned) {
  const { entries } = scanned;
  const byName = new Map(entries.map((e) => [lower(e.container), e]));
  const bindings = computeBindings(cfg, entries);

  const removed = [];
  const changed = [];
  const warnings = [];
  const bound = new Set();
  let unchanged = 0;

  for (const service of cfg.services) {
    const ref = bindings.get(service.id);
    if (!ref) continue;
    bound.add(lower(ref));
    const entry = byName.get(lower(ref));

    if (!entry) {
      removed.push({ id: service.id, name: service.name, container: ref });
    } else if (entry.reason) {
      warnings.push({ id: service.id, name: service.name, container: ref, reason: entry.reason });
      unchanged += 1;
    } else if (entry.host !== service.host || entry.port !== service.port) {
      // Scheme is not compared on purpose. Unraid labels say https for ports
      // that speak plain http often enough that a corrected scheme must never
      // be offered back as a "change".
      changed.push({
        id: service.id,
        name: service.name,
        container: ref,
        from: { scheme: service.scheme, host: service.host, port: service.port },
        to: { scheme: service.scheme, host: entry.host, port: entry.port },
      });
    } else {
      unchanged += 1;
    }
  }

  const taken = new Set([...cfg.services.map((s) => s.hostname), cfg.settings.adminHostname]);
  const added = [];
  const skipped = [];
  for (const entry of entries) {
    if (bound.has(lower(entry.container))) continue;
    if (entry.reason) {
      skipped.push({ container: entry.container, state: entry.state, reason: entry.reason });
      continue;
    }
    const hostname = uniqueHostname(slugify(entry.container), taken);
    taken.add(hostname);
    added.push({
      container: entry.container,
      name: entry.container,
      hostname,
      scheme: entry.scheme,
      host: entry.host,
      port: entry.port,
      icon: entry.icon,
      state: entry.state,
    });
  }

  return {
    available: true,
    gateway: scanned.gateway,
    added,
    removed,
    changed,
    warnings,
    skipped,
    unchanged,
  };
}

/**
 * Applies a reviewed selection. Every choice is checked against a fresh plan, so
 * only a proposed removal can remove anything — an arbitrary id cannot.
 */
function apply(cfg, scanned, selection = {}) {
  const chosen = (items) => new Set((Array.isArray(items) ? items : []).map(String));
  const toAdd = chosen(selection.add);
  const toRemove = chosen(selection.remove);
  const toUpdate = chosen(selection.update);

  const proposal = plan(cfg, scanned);
  const result = {
    added: [], removed: [], updated: [], linked: 0, errors: [],
  };

  result.linked = persistBindings(cfg, scanned);

  const doomed = new Set(proposal.removed.filter((r) => toRemove.has(r.id)).map((r) => r.id));
  if (doomed.size) {
    cfg.services = cfg.services.filter((service) => {
      if (!doomed.has(service.id)) return true;
      result.removed.push(service.name);
      return false;
    });
  }

  for (const change of proposal.changed) {
    if (!toUpdate.has(change.id)) continue;
    const service = cfg.services.find((s) => s.id === change.id);
    if (!service) continue;
    service.host = change.to.host;
    service.port = change.to.port;
    result.updated.push(service.name);
  }

  let category = '';
  if (selection.category) {
    const resolved = categories.resolve(cfg, selection.category);
    if (resolved.ok) category = resolved.name;
    else result.errors.push(resolved.error);
  }

  const taken = new Set([...cfg.services.map((s) => s.hostname), cfg.settings.adminHostname]);
  for (const item of proposal.added) {
    if (!toAdd.has(item.container)) continue;
    const hostname = uniqueHostname(item.hostname, taken);
    taken.add(hostname);
    cfg.services.push(normalizeService({
      name: item.name,
      hostname,
      scheme: item.scheme,
      host: item.host,
      port: item.port,
      icon: item.icon,
      category,
      container: item.container,
      // A label that says https usually means a self-signed certificate, and
      // sometimes means nothing; neither should block the first visit.
      insecureTls: item.scheme === 'https',
    }));
    result.added.push(item.name);
  }

  return result;
}

module.exports = {
  LABEL_WEBUI,
  LABEL_ICON,
  scan,
  plan,
  apply,
  buildEntries,
  resolveTarget,
  parseWebUi,
  computeBindings,
  persistBindings,
  slugify,
  uniqueHostname,
  containerName,
};
