'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'loc-disc-'));

const discovery = require('../src/lib/discovery');
const { normalizeService } = require('../src/lib/config');
const containers = require('./docker-containers.fixture.json');
const networks = require('./docker-networks.fixture.json');

test.after(() => fs.rmSync(process.env.CONFIG_DIR, { recursive: true, force: true }));

const scanned = { available: true, ...discovery.buildEntries(containers, networks) };
const entry = (name) => scanned.entries.find((e) => e.container === name);

function cfgWith(services = []) {
  return {
    settings: { adminHostname: 'localizer', categoryOrder: [] },
    services: services.map((s) => normalizeService(s)),
  };
}

// --- reading labels --------------------------------------------------------

test('both WebUI dialects parse, and they mean different things', () => {
  assert.deepEqual(discovery.parseWebUi('http://[IP]:[PORT:8080]/'), { scheme: 'http', kind: 'container', port: 8080 });
  assert.deepEqual(discovery.parseWebUi('http://192.168.1.5:8989'), { scheme: 'http', kind: 'host', port: 8989 });
  assert.deepEqual(discovery.parseWebUi('https://[IP]:[PORT:7443]/'), { scheme: 'https', kind: 'container', port: 7443 });
  assert.deepEqual(discovery.parseWebUi('http://[IP]:9000'), { scheme: 'http', kind: 'host', port: 9000 });
  assert.deepEqual(discovery.parseWebUi('http://[IP]/'), { scheme: 'http', kind: 'container', port: 80 });
  assert.deepEqual(discovery.parseWebUi('https://tower.local/'), { scheme: 'https', kind: 'host', port: 443 });
  assert.equal(discovery.parseWebUi(''), null);
});

// --- resolving targets -----------------------------------------------------

test('a literal address in the label is read as a host port', () => {
  assert.deepEqual([entry('sonarr').host, entry('sonarr').port], ['172.17.0.1', 8989]);
});

test('[PORT:n] is a container port, translated through its published binding', () => {
  assert.equal(entry('forgejo').port, 4177, 'not 3000, and not the SSH binding on 25');
});

test('when one number is both a host port and a container port, [PORT:n] means the container port', () => {
  // Publishes 8184->8084 and 8384->8184. Only 8384 reaches the web UI.
  assert.equal(entry('book-downloader').port, 8384);
});

test('a label that says https keeps https', () => {
  assert.deepEqual(
    [entry('ownCloud').scheme, entry('ownCloud').host, entry('ownCloud').port],
    ['https', '172.17.0.1', 7443],
  );
});

test('host networking uses the port directly, reached through the docker gateway', () => {
  assert.deepEqual([entry('Plex-Media-Server').host, entry('Plex-Media-Server').port], ['172.17.0.1', 32400]);
});

test('macvlan containers are reached on their own LAN address', () => {
  assert.deepEqual([entry('AdGuard-Home').host, entry('AdGuard-Home').port], ['192.168.1.19', 3004]);
});

test("a container borrowing another container's network uses that container's ports", () => {
  assert.deepEqual([entry('torrent-client').host, entry('torrent-client').port], ['172.17.0.1', 9099]);
});

test('a custom bridge network is reached through the published port', () => {
  assert.equal(entry('stirling').port, 8171);
});

test('an unpublished port is reported rather than guessed', () => {
  assert.match(entry('tandoor').reason, /not published/);
});

test('a stopped container explains why it has no ports', () => {
  assert.match(entry('calibre').reason, /not running/);
});

test('containers without a web UI say so', () => {
  assert.match(entry('MySQL').reason, /No web UI/);
  assert.match(entry('vpn').reason, /No web UI/);
});

test('Localizer never proposes itself', () => {
  assert.equal(entry('localizer'), undefined);
});

test('the gateway comes from the bridge network, and can be overridden', () => {
  assert.equal(scanned.gateway, '172.17.0.1');
  assert.equal(discovery.buildEntries(containers, networks, { hostAddress: '10.9.9.9' }).gateway, '10.9.9.9');
});

test('icons come from the Unraid label, and are only kept when they are http(s)', () => {
  assert.equal(entry('sonarr').icon, 'https://example.com/icons/sonarr.png');
  assert.equal(entry('book-downloader').icon, '');
});

// --- planning --------------------------------------------------------------

test('on a fresh install every reachable container is offered', () => {
  const p = discovery.plan(cfgWith(), scanned);
  assert.deepEqual(p.added.map((a) => a.hostname).sort(), [
    'adguard-home', 'book-downloader', 'forgejo', 'owncloud',
    'plex-media-server', 'sonarr', 'stirling', 'torrent-client',
  ]);
  assert.deepEqual(
    p.skipped.map((s) => s.container).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    ['calibre', 'MySQL', 'tandoor', 'vpn'],
  );
  assert.deepEqual([p.removed.length, p.changed.length, p.unchanged], [0, 0, 0]);
});

test('a service named after its container is linked, not offered again', () => {
  const p = discovery.plan(cfgWith([
    { id: 'plex', name: 'Plex-Media-Server', hostname: 'plex', host: '172.17.0.1', port: 32400 },
  ]), scanned);
  assert.ok(!p.added.some((a) => a.container === 'Plex-Media-Server'));
  assert.equal(p.unchanged, 1);
});

test('a renamed tile stays linked through its stored container', () => {
  const p = discovery.plan(cfgWith([
    { id: 'tv', name: 'TV Shows', hostname: 'tv', host: '172.17.0.1', port: 8989, container: 'sonarr' },
  ]), scanned);
  assert.ok(!p.added.some((a) => a.container === 'sonarr'), 'not re-offered as new');
  assert.ok(!p.removed.some((r) => r.id === 'tv'), 'not reported as gone');
});

test('a service whose container disappeared is offered for removal', () => {
  const p = discovery.plan(cfgWith([
    { id: 'old', name: 'Old', hostname: 'old', host: '172.17.0.1', port: 1234, container: 'deleted-thing' },
  ]), scanned);
  assert.deepEqual(p.removed, [{ id: 'old', name: 'Old', container: 'deleted-thing' }]);
});

test('services pointed outside Docker are never flagged', () => {
  const p = discovery.plan(cfgWith([
    { id: 'nas', name: 'NAS', hostname: 'nas', host: '192.168.1.10', port: 5000 },
  ]), scanned);
  assert.equal(p.removed.length, 0);
  assert.equal(p.changed.length, 0);
});

test('an unambiguous address match links a service that was added by hand', () => {
  const p = discovery.plan(cfgWith([
    { id: 'code', name: 'Code', hostname: 'code', host: '172.17.0.1', port: 4177 },
  ]), scanned);
  assert.ok(!p.added.some((a) => a.container === 'forgejo'));
  assert.equal(p.unchanged, 1);
});

test('a moved port is reported as a change', () => {
  const p = discovery.plan(cfgWith([
    { id: 's', name: 'sonarr', hostname: 'sonarr', host: '172.17.0.1', port: 9999 },
  ]), scanned);
  assert.deepEqual(p.changed[0].to, { scheme: 'http', host: '172.17.0.1', port: 8989 });
});

test('a corrected scheme is not offered back as a change', () => {
  // The label says https; the owner set http because that is what the port speaks.
  const p = discovery.plan(cfgWith([
    { id: 'oc', name: 'ownCloud', hostname: 'owncloud', scheme: 'http', host: '172.17.0.1', port: 7443 },
  ]), scanned);
  assert.equal(p.changed.length, 0);
  assert.equal(p.unchanged, 1);
});

test('new hostnames avoid ones already in use', () => {
  const p = discovery.plan(cfgWith([
    { id: 'x', name: 'Something else', hostname: 'sonarr', host: '10.0.0.5', port: 1 },
  ]), scanned);
  assert.equal(p.added.find((a) => a.container === 'sonarr').hostname, 'sonarr-2');
});

// --- applying --------------------------------------------------------------

test('apply adds only what was ticked, links it, and files it', () => {
  const c = cfgWith();
  const result = discovery.apply(c, scanned, { add: ['sonarr', 'forgejo'], category: 'Imported' });
  assert.deepEqual(result.added.sort(), ['forgejo', 'sonarr']);
  assert.equal(c.services.length, 2);
  for (const service of c.services) {
    assert.equal(service.category, 'Imported');
    assert.ok(service.container, 'container binding is stored');
  }
  assert.ok(c.settings.categoryOrder.includes('Imported'));
});

test('apply cannot remove a service that was not proposed for removal', () => {
  const c = cfgWith([{ id: 'nas', name: 'NAS', hostname: 'nas', host: '192.168.1.10', port: 5000 }]);
  const result = discovery.apply(c, scanned, { remove: ['nas'] });
  assert.equal(result.removed.length, 0);
  assert.equal(c.services.length, 1);
});

test('apply removes and updates what was ticked', () => {
  const c = cfgWith([
    { id: 'old', name: 'Old', hostname: 'old', host: '172.17.0.1', port: 1, container: 'gone' },
    { id: 's', name: 'sonarr', hostname: 'sonarr', host: '172.17.0.1', port: 9999 },
  ]);
  const result = discovery.apply(c, scanned, { remove: ['old'], update: ['s'] });
  assert.deepEqual(result.removed, ['Old']);
  assert.deepEqual(result.updated, ['sonarr']);
  assert.equal(c.services.find((s) => s.id === 's').port, 8989);
});

test('persisting bindings links name matches once', () => {
  const c = cfgWith([{ id: 'f', name: 'forgejo', hostname: 'git', host: '172.17.0.1', port: 4177 }]);
  assert.equal(discovery.persistBindings(c, scanned), 1);
  assert.equal(c.services[0].container, 'forgejo');
  assert.equal(discovery.persistBindings(c, scanned), 0, 'idempotent');
});

test('slugs are DNS-safe', () => {
  assert.equal(discovery.slugify('Plex-Media-Server'), 'plex-media-server');
  assert.equal(discovery.slugify('Calibre_Book_Organizer'), 'calibre-book-organizer');
  assert.equal(discovery.slugify('Café Écoute'), 'cafe-ecoute');
  assert.equal(discovery.slugify('___'), 'service');
});

test('scan reports Docker as unavailable when there is no socket', async () => {
  const result = await discovery.scan({ socketPath: path.join(os.tmpdir(), 'no-such-docker.sock') });
  assert.equal(result.available, false);
});
