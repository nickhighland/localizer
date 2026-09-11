# Changelog

## 2.0.0

**Unraid Reverse Proxy is now Localizer.** The repository, the container image and the container
name all change:

| | Before | Now |
|---|---|---|
| Repository | `nickhighland/unraid-reverse-proxy` | `nickhighland/localizer` |
| Image | `ghcr.io/nickhighland/unraid-reverse-proxy` | `ghcr.io/nickhighland/localizer` |
| Container | `unraid-reverse-proxy` | `localizer` |
| Admin hostname on new installs | `proxy.local` | `localizer.local` |

GitHub redirects the old repository address. The old image stops receiving updates at 1.3.0.
Existing configuration is carried over untouched, including an admin hostname you already set.

### Added

- **Refresh from Unraid.** With the Docker socket mapped in read-only, Localizer compares its tiles
  with the containers Docker reports and lists what is new, gone or moved; only ticked changes
  apply, and moved ports start unticked. It reads Unraid's own WebUI and icon labels, treats
  `[PORT:n]` as a container port and a literal port as a host port, and handles host networking,
  macvlan and ipvlan, and containers that share another container's network.
- **Tiles stay linked to their containers.** A tile records the container it came from, so renaming
  it never makes that container look new or deleted. Existing tiles are linked on startup.
- **An edit button on every tile.** Signed in, each tile has one in its bottom-right corner, for
  renaming it, changing its icon, or moving it to another category.
- **Categories you can manage directly.** Create empty categories, rename and delete them from their
  dashboard headings or from Settings → Categories, and drag them into order. Deleting a category
  moves its tiles to Ungrouped. Names are case-insensitive, so `media` files under `Media`.
- `unraid/localizer-bridge.sh`, a User Scripts boot script that re-attaches the bridge network after
  a reboot or a template Apply.

### Changed

- Settings forms no longer carry the category list, so a form left open in one tab cannot undo a
  category created in another.
- Visitors who are not signed in no longer see empty categories.
- "Sign in" on the dashboard now returns you to the dashboard.


## 1.3.0

### Added

- **Per-service "Send X-Forwarded headers" toggle.** Home Assistant answers `400 Bad Request` to
  any request carrying `X-Forwarded-For` unless its own `trusted_proxies` list names the sender.
  Rather than requiring everyone to edit `configuration.yaml`, the headers can now be switched off
  for a single service.

## 1.1.1

Fixes the version string, which still reported 1.0.0 in the 1.1.0 image.

## 1.1.0

### Added

- **Categories.** Services can be filed into groups, shown as collapsible headings on the
  dashboard. Collapse state is per browser, so one viewer folding a group away does not fold it
  away for everyone.
- **Sorting.** Custom order, alphabetical, or by status (offline first). In custom order a
  signed-in viewer can drag tiles on the dashboard itself — within a group to reorder, or onto
  another group to refile. A drop sends order and category in one request, so a move never
  half-applies.
- **Appearance settings**: accent colour, forced light/dark or match-the-device, tiles or rows,
  comfortable or compact density, three backgrounds, and toggles for status dots, hostnames and
  descriptions.

### Fixed

- `/api/services/order` sat below the `/api/services/:id` matcher. Since `order` is alphanumeric
  it was read as a service id and answered 404, so **drag-to-reorder had never persisted** since
  1.0.0. It now precedes the matcher, with a regression test.
- The light palette was defined only inside a `prefers-color-scheme` media query, so forcing a
  light theme set the attribute and changed nothing. It is now also bound to `[data-theme]`.

## 1.0.0

First release.

### Added

- **Reverse proxy** routing by `Host` header to any container on the network, with WebSocket
  upgrades, streaming/SSE support, hop-by-hop header handling per RFC 9110, and rewriting of
  upstream redirects that point back at a raw `ip:port`.
- **Built-in mDNS responder** (RFC 6762) so `.local` names resolve on the LAN with no DNS
  configuration anywhere else. Implemented against the Node standard library — no Avahi
  dependency, no npm packages.
- **Multiple domain suffixes.** Every service answers on all of them at once, so `plex.local`,
  `plex.home.arpa` and `plex.lan` can reach the same container. The settings screen states which
  suffixes resolve by themselves and prints the exact wildcard DNS record for the ones that do
  not, and warns about HSTS-preloaded TLDs such as `.dev` and `.app`, where plain HTTP cannot work.
- **Launch screen** listing every service with live up/down indicators, instant search, and a
  keyboard shortcut.
- **Admin panel** behind a login: add, edit, reorder, enable and disable routes. Passwords are
  hashed with scrypt; sessions are HMAC-signed `HttpOnly` cookies; failed logins are throttled.
- **Icon library** backed by the Unraid Community Applications catalogue — roughly 3,900 icons,
  searched on demand and distilled to a ~600 KB local index rather than bundled. Chosen icons are
  copied into `/config` so tiles survive the source host going away. Custom uploads and pasted
  URLs are supported too.
- **Health checks** that TCP-probe each upstream on an interval.
- **Configuration export and import** as JSON.
- Startup and admin-panel warnings when the container is running on a Docker bridge address,
  which is the one misconfiguration that silently breaks name resolution.

### Notes

- The image is 108 MB and has no runtime dependencies beyond a Node runtime.
- 63 tests cover the mDNS wire format, proxy header handling, suffix rules, config migration and
  the full HTTP surface. None of them need network access.
