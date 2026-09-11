'use strict';

const config = require('../lib/config');
const auth = require('../lib/auth');
const { probe } = require('../lib/health');
const icons = require('../lib/icons');
const suffixLib = require('../lib/suffixes');
const categories = require('../lib/categories');
const discovery = require('../lib/discovery');
const { sendJson, readJson, readBody } = require('../lib/http-util');

// categoryOrder is deliberately absent. Categories change only through their own
// endpoints, so a settings form holding a stale copy cannot quietly undo a
// category created from the dashboard in another tab.
const SETTING_KEYS = [
  'domainSuffixes', 'adminHostname', 'advertiseIp', 'mdnsEnabled', 'appearance', 'dashboardSort',
  'dashboardRequiresLogin', 'dashboardTitle', 'healthCheckSeconds', 'httpPort',
];

const DEFAULT_TITLE = 'Localizer';

function serviceForAdmin(service, cfg, health) {
  return {
    ...service,
    fqdn: config.fqdn(service, cfg),
    fqdns: config.allFqdns(service, cfg),
    url: config.publicUrl(service, cfg),
    urls: config.publicUrls(service, cfg),
    status: health.get(service.id),
  };
}

function serviceForPublic(service, cfg, health) {
  const state = health.get(service.id);
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    category: service.category,
    icon: service.icon,
    color: service.color,
    fqdn: config.fqdn(service, cfg),
    fqdns: config.allFqdns(service, cfg),
    url: config.publicUrl(service, cfg),
    urls: config.publicUrls(service, cfg),
    status: state ? { up: state.up, latencyMs: state.latencyMs, checkedAt: state.checkedAt } : null,
  };
}

async function scanDocker(res) {
  try {
    return await discovery.scan();
  } catch (err) {
    sendJson(res, err.status || 502, { error: err.message });
    return null;
  }
}

async function handleApi(req, res, ctx) {
  const { url, health, authenticated } = ctx;
  const pathname = url.pathname;
  const method = req.method;
  const cfg = config.load();

  const requireAuth = () => {
    if (authenticated) return false;
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  };

  // --- session ---------------------------------------------------------
  // Everything the dashboard needs to render itself, login or not.
  if (pathname === '/api/dashboard' && method === 'GET') {
    if (!authenticated && cfg.settings.dashboardRequiresLogin) {
      return sendJson(res, 401, { error: 'Not signed in.' });
    }
    const visible = authenticated
      ? cfg.services
      : cfg.services.filter((s) => s.enabled && s.showOnDashboard);
    // Editors see empty categories so they can fill them; visitors only see
    // groups that have something in them.
    const allCategories = config.categories(cfg);
    const shownCategories = authenticated
      ? allCategories
      : allCategories.filter((name) => visible.some((s) => categories.key(s.category) === categories.key(name)));

    return sendJson(res, 200, {
      title: cfg.settings.dashboardTitle,
      appearance: cfg.settings.appearance,
      sort: cfg.settings.dashboardSort,
      categories: shownCategories,
      canEdit: authenticated,
      services: visible.map((s) => (authenticated
        ? serviceForAdmin(s, cfg, health)
        : serviceForPublic(s, cfg, health))),
    });
  }

  if (pathname === '/api/session' && method === 'GET') {
    return sendJson(res, 200, {
      configured: auth.isConfigured(),
      authenticated,
      username: authenticated ? cfg.auth.username : null,
      dashboardRequiresLogin: cfg.settings.dashboardRequiresLogin,
      dashboardTitle: cfg.settings.dashboardTitle,
      domainSuffixes: config.suffixes(cfg),
      domainSuffix: config.primarySuffix(cfg),
    });
  }

  if (pathname === '/api/setup' && method === 'POST') {
    if (auth.isConfigured()) {
      return sendJson(res, 409, { error: 'An account already exists.' });
    }
    const body = await readJson(req);
    const result = auth.createAccount(body.username, body.password);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    const session = auth.createSession(String(body.username).trim());
    res.setHeader('set-cookie', auth.cookieHeader(session.token, session.maxAge));
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/login' && method === 'POST') {
    const key = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const throttle = auth.throttleStatus(key);
    if (throttle.blocked) {
      return sendJson(res, 429, {
        error: `Too many failed attempts. Try again in ${Math.ceil(throttle.retryAfter / 60)} minute(s).`,
      });
    }
    const body = await readJson(req);
    const ok = cfg.auth
      && String(body.username || '').trim() === cfg.auth.username
      && auth.verifyPassword(String(body.password || ''), cfg.auth);
    if (!ok) {
      auth.recordFailure(key);
      return sendJson(res, 401, { error: 'Incorrect username or password.' });
    }
    auth.recordSuccess(key);
    const session = auth.createSession(cfg.auth.username);
    res.setHeader('set-cookie', auth.cookieHeader(session.token, session.maxAge));
    return sendJson(res, 200, { ok: true, username: cfg.auth.username });
  }

  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('set-cookie', auth.clearCookieHeader());
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/password' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = auth.changePassword(body.currentPassword, body.newPassword);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    const session = auth.createSession(cfg.auth.username);
    res.setHeader('set-cookie', auth.cookieHeader(session.token, session.maxAge));
    return sendJson(res, 200, { ok: true });
  }

  // --- services --------------------------------------------------------
  if (pathname === '/api/services' && method === 'GET') {
    if (authenticated) {
      return sendJson(res, 200, {
        services: cfg.services.map((s) => serviceForAdmin(s, cfg, health)),
      });
    }
    if (cfg.settings.dashboardRequiresLogin) {
      return sendJson(res, 401, { error: 'Not signed in.' });
    }
    const visible = cfg.services.filter((s) => s.enabled && s.showOnDashboard);
    return sendJson(res, 200, { services: visible.map((s) => serviceForPublic(s, cfg, health)) });
  }

  if (pathname === '/api/services' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = config.validateService(body);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    // Validation first: resolving a category may create it, and a rejected
    // service should not leave a new category behind.
    const category = categories.resolve(cfg, body.category);
    if (!category.ok) return sendJson(res, 400, { error: category.error });
    result.service.category = category.name;
    cfg.services.push(result.service);
    config.save();
    ctx.refresh();
    return sendJson(res, 201, { service: serviceForAdmin(result.service, cfg, health) });
  }

  // Must precede the /:id matcher below: "order" is alphanumeric and would
  // otherwise be read as a service id and 404.
  if (pathname === '/api/services/order' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];

    // Dragging a tile into another group both reorders and recategorises.
    // Every new name is checked before anything is touched.
    const moves = body.categories && typeof body.categories === 'object'
      ? Object.entries(body.categories) : [];
    for (const [, raw] of moves) {
      const trimmed = String(raw ?? '').trim();
      if (trimmed && !categories.find(cfg, trimmed)) {
        const check = categories.clean(trimmed);
        if (!check.ok) return sendJson(res, 400, { error: check.error });
      }
    }
    for (const [id, raw] of moves) {
      const service = cfg.services.find((s) => s.id === id);
      if (!service) continue;
      const resolved = categories.resolve(cfg, raw);
      if (resolved.ok) service.category = resolved.name;
    }

    const byId = new Map(cfg.services.map((s) => [s.id, s]));
    const reordered = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const s of cfg.services) if (!ids.includes(s.id)) reordered.push(s);
    cfg.services = reordered;
    config.save();
    return sendJson(res, 200, { ok: true });
  }

  const serviceMatch = pathname.match(/^\/api\/services\/([A-Za-z0-9]+)$/);
  if (serviceMatch) {
    if (requireAuth()) return undefined;
    const id = serviceMatch[1];
    const index = cfg.services.findIndex((s) => s.id === id);
    if (index < 0) return sendJson(res, 404, { error: 'No such service.' });

    if (method === 'DELETE') {
      const [removed] = cfg.services.splice(index, 1);
      config.save();
      ctx.refresh();
      return sendJson(res, 200, { ok: true, removed: removed.name });
    }
    if (method === 'PUT' || method === 'PATCH') {
      const body = await readJson(req);
      const merged = { ...cfg.services[index], ...body, id };
      const result = config.validateService(merged, id);
      if (!result.ok) return sendJson(res, 400, { error: result.error });
      if ('category' in body) {
        const category = categories.resolve(cfg, body.category);
        if (!category.ok) return sendJson(res, 400, { error: category.error });
        result.service.category = category.name;
      }
      cfg.services[index] = result.service;
      config.save();
      ctx.refresh();
      return sendJson(res, 200, { service: serviceForAdmin(result.service, cfg, health) });
    }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }

  // --- categories ------------------------------------------------------
  // POSTs with JSON bodies throughout: names can hold spaces and slashes, and
  // keeping them out of the path means no escaping and no route to shadow.
  if (pathname === '/api/categories' && method === 'GET') {
    if (requireAuth()) return undefined;
    return sendJson(res, 200, { categories: categories.withCounts(cfg) });
  }

  if (pathname === '/api/categories' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = categories.add(cfg, body.name);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    config.save();
    return sendJson(res, 201, { name: result.name, categories: categories.withCounts(cfg) });
  }

  if (pathname === '/api/categories/rename' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = categories.rename(cfg, body.from, body.to);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    config.save();
    return sendJson(res, 200, {
      name: result.name, previous: result.previous, moved: result.moved, categories: categories.withCounts(cfg),
    });
  }

  if (pathname === '/api/categories/delete' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = categories.remove(cfg, body.name);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    config.save();
    return sendJson(res, 200, { name: result.name, moved: result.moved, categories: categories.withCounts(cfg) });
  }

  if (pathname === '/api/categories/order' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const result = categories.reorder(cfg, body.order);
    if (!result.ok) return sendJson(res, 400, { error: result.error });
    config.save();
    return sendJson(res, 200, { categories: categories.withCounts(cfg) });
  }

  // --- container discovery ---------------------------------------------
  if (pathname === '/api/discovery' && method === 'GET') {
    if (requireAuth()) return undefined;
    const scanned = await scanDocker(res);
    if (!scanned) return undefined;
    if (!scanned.available) return sendJson(res, 200, { available: false, socket: scanned.socket });
    return sendJson(res, 200, { ...discovery.plan(cfg, scanned), suffix: config.primarySuffix(cfg) });
  }

  if (pathname === '/api/discovery/apply' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    // Rescanned rather than trusting what the browser saw: Docker may have
    // changed while the review dialog was open.
    const scanned = await scanDocker(res);
    if (!scanned) return undefined;
    if (!scanned.available) {
      return sendJson(res, 409, { error: 'Localizer cannot reach Docker, so there is nothing to apply.' });
    }
    const result = discovery.apply(cfg, scanned, body);
    config.save();
    ctx.refresh();
    return sendJson(res, 200, result);
  }

  // --- status & diagnostics -------------------------------------------
  if (pathname === '/api/status' && method === 'GET') {
    if (!authenticated && cfg.settings.dashboardRequiresLogin) {
      return sendJson(res, 401, { error: 'Not signed in.' });
    }
    await health.runOnce();
    return sendJson(res, 200, { status: health.snapshot() });
  }

  if (pathname === '/api/test' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const host = String(body.host || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').split(':')[0];
    const port = Number(body.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      return sendJson(res, 400, { error: 'Provide a valid address and port.' });
    }
    const result = await probe(host, port);
    return sendJson(res, 200, result);
  }

  if (pathname === '/api/system' && method === 'GET') {
    if (requireAuth()) return undefined;
    return sendJson(res, 200, ctx.systemInfo());
  }

  // --- icon library ----------------------------------------------------
  // Backed by the Community Applications feed; see lib/icons.js.
  if (pathname === '/api/icons' && method === 'GET') {
    if (requireAuth()) return undefined;
    const limit = Math.min(120, Math.max(1, Number(url.searchParams.get('limit')) || 40));
    try {
      const found = await icons.search(url.searchParams.get('q') || '', limit);
      return sendJson(res, 200, found);
    } catch (err) {
      return sendJson(res, 503, { error: err.message });
    }
  }

  if (pathname === '/api/icons/status' && method === 'GET') {
    if (requireAuth()) return undefined;
    return sendJson(res, 200, icons.indexStatus());
  }

  if (pathname === '/api/icons/refresh' && method === 'POST') {
    if (requireAuth()) return undefined;
    try {
      const index = await icons.refreshIndex();
      return sendJson(res, 200, { ok: true, count: index.entries.length, fetchedAt: index.fetchedAt });
    } catch (err) {
      return sendJson(res, 503, { error: err.message });
    }
  }

  // Copies a remote icon into /config so the dashboard survives the source
  // host going away.
  if (pathname === '/api/icons/cache' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const saved = await icons.cacheRemoteIcon(body.url);
    return sendJson(res, 200, saved);
  }

  if (pathname === '/api/icons/upload' && method === 'POST') {
    if (requireAuth()) return undefined;
    const buffer = await readBody(req, icons.MAX_ICON_BYTES + 1024);
    const saved = await icons.saveUploadedIcon(buffer, req.headers['content-type']);
    return sendJson(res, 200, saved);
  }

  // --- settings & backup ----------------------------------------------
  if (pathname === '/api/settings' && method === 'GET') {
    if (requireAuth()) return undefined;
    return sendJson(res, 200, {
      settings: cfg.settings,
      suffixInfo: config.suffixes(cfg).map(suffixLib.describe),
      suffixSuggestions: suffixLib.SUGGESTIONS.map(suffixLib.describe),
    });
  }

  // Lets the settings UI preview a suffix before it is saved.
  if (pathname === '/api/suffix-check' && method === 'GET') {
    if (requireAuth()) return undefined;
    const candidate = suffixLib.validate(url.searchParams.get('suffix') || '');
    if (!candidate.ok) return sendJson(res, 200, { ok: false, error: candidate.error });
    return sendJson(res, 200, { ok: true, ...suffixLib.describe(candidate.suffix) });
  }

  if (pathname === '/api/settings' && (method === 'PUT' || method === 'PATCH')) {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    const next = { ...cfg.settings };
    for (const key of SETTING_KEYS) {
      if (!(key in body)) continue;
      next[key] = body[key];
    }

    const suffixResult = suffixLib.validateList(next.domainSuffixes ?? config.suffixes(cfg));
    if (!suffixResult.ok) return sendJson(res, 400, { error: suffixResult.error });
    next.domainSuffixes = suffixResult.suffixes;
    delete next.domainSuffix;
    next.adminHostname = String(next.adminHostname || 'localizer').trim().toLowerCase();
    if (!config.HOSTNAME_RE.test(next.adminHostname)) {
      return sendJson(res, 400, { error: 'Admin hostname must be a valid DNS label.' });
    }
    if (cfg.services.some((s) => s.hostname === next.adminHostname)) {
      return sendJson(res, 400, { error: `"${next.adminHostname}" is already used by a service.` });
    }
    const advertise = String(next.advertiseIp || 'auto').trim();
    if (advertise !== 'auto' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(advertise)) {
      return sendJson(res, 400, { error: 'Advertised IP must be "auto" or an IPv4 address.' });
    }
    next.advertiseIp = advertise || 'auto';
    next.mdnsEnabled = next.mdnsEnabled !== false;
    next.dashboardRequiresLogin = next.dashboardRequiresLogin === true;
    next.dashboardTitle = String(next.dashboardTitle || DEFAULT_TITLE).trim().slice(0, 60) || DEFAULT_TITLE;

    const ALLOWED = {
      theme: ['auto', 'dark', 'light'],
      layout: ['grid', 'list'],
      density: ['comfortable', 'compact'],
      background: ['aurora', 'mesh', 'plain'],
    };
    const incoming = (body.appearance && typeof body.appearance === 'object') ? body.appearance : {};
    const appearance = { ...cfg.settings.appearance };
    for (const [key, values] of Object.entries(ALLOWED)) {
      if (key in incoming) {
        if (!values.includes(incoming[key])) {
          return sendJson(res, 400, { error: `${key} must be one of: ${values.join(', ')}.` });
        }
        appearance[key] = incoming[key];
      }
    }
    if ('accent' in incoming) {
      if (!/^#[0-9a-fA-F]{6}$/.test(String(incoming.accent))) {
        return sendJson(res, 400, { error: 'Accent must be a hex colour such as #4f8cff.' });
      }
      appearance.accent = String(incoming.accent).toLowerCase();
    }
    for (const flag of ['showStatus', 'showDescriptions', 'showHostnames', 'groupByCategory']) {
      if (flag in incoming) appearance[flag] = incoming[flag] === true;
    }
    next.appearance = appearance;

    const sorts = ['manual', 'name', 'status'];
    next.dashboardSort = sorts.includes(next.dashboardSort) ? next.dashboardSort : cfg.settings.dashboardSort;

    const interval = Number(next.healthCheckSeconds);
    next.healthCheckSeconds = Number.isFinite(interval) ? Math.min(600, Math.max(5, Math.round(interval))) : 30;
    const port = Number(next.httpPort);
    next.httpPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : cfg.settings.httpPort;

    const portChanged = next.httpPort !== cfg.settings.httpPort;
    cfg.settings = next;
    config.save();
    ctx.refresh();
    return sendJson(res, 200, {
      settings: cfg.settings,
      suffixInfo: config.suffixes(cfg).map(suffixLib.describe),
      restartRequired: portChanged,
    });
  }

  if (pathname === '/api/export' && method === 'GET') {
    if (requireAuth()) return undefined;
    res.setHeader('content-disposition', 'attachment; filename="localizer-backup.json"');
    return sendJson(res, 200, { version: cfg.version, settings: cfg.settings, services: cfg.services });
  }

  if (pathname === '/api/import' && method === 'POST') {
    if (requireAuth()) return undefined;
    const body = await readJson(req);
    if (!Array.isArray(body.services)) {
      return sendJson(res, 400, { error: 'Backup file must contain a "services" array.' });
    }
    const imported = [];
    const seen = new Set();
    for (const raw of body.services) {
      const normalized = config.normalizeService(raw);
      if (!normalized.name || !normalized.hostname || !normalized.host) continue;
      if (seen.has(normalized.hostname)) continue;
      seen.add(normalized.hostname);
      imported.push(normalized);
    }
    cfg.services = imported;
    if (body.settings && typeof body.settings === 'object') {
      cfg.settings = { ...cfg.settings, ...body.settings };
    }
    config.save();
    ctx.refresh();
    return sendJson(res, 200, { ok: true, count: imported.length });
  }

  return sendJson(res, 404, { error: 'Unknown endpoint.' });
}

module.exports = { handleApi };
