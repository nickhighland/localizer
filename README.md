<img src="branding/icon.png" width="72" align="right" alt="">

# Localizer

Give every Docker container on your Unraid server a name.

Instead of remembering `192.168.254.254:8080`, you open **`openwebui.local`**. Instead of
`192.168.254.254:8989`, **`sonarr.local`**. Localizer finds the containers Unraid is already running,
gives each one a name, and puts them all on one launch screen — reachable from every machine on
your network, with no router settings, no Pi-hole entries and no `hosts` files.

```
                     openwebui.local ─┐
                        sonarr.local ─┤                  ┌─ 192.168.254.254:8080
                          plex.local ─┼─▶   Localizer  ──┼─ 192.168.254.254:8989
                 homeassistant.local ─┘   (port 80)      └─ 192.168.254.254:32400
```

---

## Why this exists

A reverse proxy alone **cannot** give you `openwebui.local`. Two separate things have to happen:

1. **Name resolution** — something on the network has to answer "what IP is `openwebui.local`?"
2. **Host routing** — something has to receive that request and forward it to the right container.

Nginx Proxy Manager, SWAG, Traefik and Caddy all do step 2 well, but none of them do step 1 — you
still have to hand-add a DNS record somewhere for every single service. Localizer does both. It
runs an **mDNS responder** (the same protocol behind `tower.local` and AirPlay) that answers for
every hostname you configure, so clients find it with zero configuration.

> `.local` is reserved for mDNS by [RFC 6762](https://www.rfc-editor.org/rfc/rfc6762). Putting
> `.local` records into a normal DNS server — a common workaround — misbehaves on Apple devices
> in particular. Answering over mDNS is the correct way to do this.

Unraid does not ship anything like this. It runs avahi (which is why `tower.local` resolves), but
avahi only advertises the server itself, not per-container aliases. The Docker tab's WebUI links
are a list of `ip:port` links with no hostnames and no proxying.

## What you get

| | |
|---|---|
| **Launch screen** | Every service as a tile, with a live up/down dot, instant search and collapsible categories |
| **Refresh from Unraid** | Compares your tiles with the containers Docker reports, and shows what is new, gone or moved |
| **Quick edit** | Signed in, every tile has an edit button: rename it, change its icon, or refile it |
| **Reverse proxy** | Routes by `Host` header, with WebSocket support, streaming/SSE, and redirect rewriting |
| **mDNS responder** | Advertises every hostname you configure, so `.local` resolves LAN-wide |
| **Admin panel** | Add, edit, reorder, enable and disable routes behind a login |
| **Icon library** | Search ~3,900 icons from the Unraid Community Applications catalogue, or upload your own |
| **Health checks** | Each upstream is TCP-probed on an interval; the dashboard shows what is down |
| **Backup** | Export and import the whole configuration as JSON |

No npm dependencies — Localizer uses only the Node standard library. The image is about 110 MB.

---

## Installing on Unraid

### 1. Give it its own IP address

In the Docker template set:

- **Network Type:** `Custom : br0`
- **Fixed IP address:** something outside your DHCP pool, e.g. `192.168.254.20`

This matters for two reasons:

1. **Port 80 is already taken.** The Unraid webGUI owns port 80 on the host. A container with its
   own IP has its own port 80, so your URLs stay clean — `openwebui.local`, not
   `openwebui.local:8080`.
2. **mDNS needs real multicast.** Docker's default bridge network does not carry multicast to the
   LAN, so `.local` names would resolve to `172.17.x.x` — an address nothing outside the server
   can reach.

If you start it on the default bridge anyway, the container says so loudly in its log **and** on
the admin panel's System tab. That warning is not cosmetic; nothing will work until you fix it.

### 2. Give it a way back to the host

`br0` is a macvlan or ipvlan network, and a container on one **cannot reach its own host**. Your
other containers publish their ports on that host, so without a second network Localizer can see
the LAN but not the services it exists to reach — every tile reads as offline. Attach the default
bridge once:

```bash
docker network connect bridge localizer
```

The Unraid template can only set one network, and pressing **Apply** on it recreates the container,
which drops this attachment. To make it permanent, install
[`unraid/localizer-bridge.sh`](unraid/localizer-bridge.sh) with the **User Scripts** plugin and
schedule it **At Startup of Array**. It waits for Docker, checks, and attaches only if needed.

Localizer notices if you skip this: when every upstream refuses at once, it says so in the log and
on the System tab, with the command.

### 3. Optional: let it see your containers

**Refresh from Unraid** reads the Docker socket. Add a path to the template:

| Container path | Host path | Access |
|---|---|---|
| `/var/run/docker.sock` | `/var/run/docker.sock` | Read Only |

Localizer only ever sends read requests. Be aware, though, that anything holding the Docker socket
can control Docker, and a read-only mount does not restrict the API — mapping it in is a decision
to trust this container. Everything else works without it.

### Steps

1. **Apps → search for Localizer**, or add [`unraid/localizer.xml`](unraid/localizer.xml) manually.
2. Set **Network Type** to `Custom : br0` and give it a **Fixed IP**.
3. Leave **Config Storage** at `/mnt/user/appdata/localizer` and **HTTP Port** at `80`.
4. Keep or remove the **Docker Socket** path (see above), then Apply.
5. Attach the bridge network, and install the boot script.
6. Browse to the IP you assigned and create your login. Nothing is preconfigured and there is no
   default password.
7. Open **Refresh from Unraid** and tick the containers you want.

### Running it anywhere else

```bash
docker compose up -d
```

`docker-compose.yml` uses host networking and port 8088 so it does not fight anything, and maps the
Docker socket read-only for discovery.

---

## Using it

### Refresh from Unraid

The **Refresh from Unraid** button — **Containers** on the dashboard toolbar, and in the admin panel — compares your tiles with what
Docker is running right now, and nothing changes until you apply:

| Section | Ticked by default | Applying it |
|---|---|---|
| **New in Unraid** | yes | adds a tile, with its Unraid icon, into a category you pick |
| **Gone from Unraid** | yes | removes the tile — nothing in Docker is touched |
| **Moved** | no | points the tile at the port Docker now reports |

Moved changes start unticked because you may have set a port on purpose. The scheme is never
offered as a change either: Unraid templates say `https` for ports that speak plain HTTP often
enough that a scheme you corrected must not be put back.

Containers without a web UI, or whose port is not published, are listed with the reason rather
than guessed at.

Localizer reads Unraid's own `net.unraid.docker.webui` and `net.unraid.docker.icon` labels, and
takes their two dialects at their word: in `http://[IP]:[PORT:8080]` the `8080` is a **container**
port, translated through whatever publishes it; in `http://192.168.1.5:8989` the `8989` is a
**host** port. That distinction is not academic — a container can publish `8184→8084` and
`8384→8184` at once, and only one reading reaches the web UI. It also handles host networking,
macvlan and ipvlan containers on their own address, and containers that borrow another's network.

Each tile remembers which container it came from, so **renaming a tile never makes its container
look new, or gone**.

### Adding a service by hand

For anything Docker does not run — a NAS, a router, a VM — click **+ Add service**:

| Field | Example |
|---|---|
| Display name | `Open WebUI` |
| Hostname | `openwebui` → becomes `openwebui.local` |
| Target address / port | `192.168.254.254` / `8080` |

You can paste `192.168.254.254:8080` straight into the address box and the port splits out
automatically. **Test connection** probes the address before you save.

### Organising the dashboard

Sign in and the dashboard becomes editable:

- **The edit button** in the bottom-right corner of each tile renames it, changes its icon (library,
  upload or URL) or moves it to another category. **All settings** opens the full form.
- **+ Category** creates an empty category, ready for tiles.
- **Category headings** have rename and delete buttons. Deleting a category moves its tiles to
  Ungrouped; no service is removed.
- **Drag tiles** to reorder them, onto another heading to refile them, or into an empty category.
  While dragging, an *Ungrouped* target appears for taking a tile out of its category.

**Settings → Categories** does the same from the admin panel, including dragging categories into
order. Category names are case-insensitive, so typing `media` on a service files it under `Media`.

The sort control switches between your custom order, alphabetical, and status (offline first).
Collapsed categories are remembered per browser, so one person folding one away does not fold it
away for everyone. Visitors who are not signed in never see empty categories.

### Appearance

Settings → Appearance controls how the dashboard looks for everyone:

| | |
|---|---|
| Accent colour | Any hex value, with eight presets |
| Theme | Match the device, or force light or dark |
| Layout | Tiles or full-width rows |
| Density | Comfortable or compact |
| Background | Aurora, mesh, or plain |
| Toggles | Status dots, hostnames, descriptions, grouping |

### Icons

**Browse library** searches the Unraid Community Applications catalogue — about 3,900 app icons,
the same ones you see in Apps. Search "plex" and you get Plex; the list is ranked so the real app
comes before companion tools.

The catalogue index is fetched on first use (~1 second, cached in `/config/icon-index.json`,
refreshed weekly). Choosing an icon downloads a copy into `/config/icons/` so your dashboard keeps
working even if the original host disappears. You can also **Upload…** your own PNG/JPEG/SVG, or
paste any image URL. **Clear** it and the tile shows the service's initials in its colour.

### The advanced toggles

Defaults are right for almost everything; open **Advanced** if something misbehaves.

| Toggle | Default | Turn it off when |
|---|---|---|
| Forward WebSockets | on | Never, unless you are debugging |
| Preserve Host header | on | The app rejects the `.local` hostname or redirects oddly |
| Send X-Forwarded headers | on | The app answers `400` — Home Assistant does, until its `trusted_proxies` is set |
| Rewrite redirects | on | The app already generates correct external URLs |
| Ignore TLS certificate errors | off | The target is HTTPS with a self-signed certificate |
| Show on dashboard | on | You want the route but not the tile |

---

## Domain suffixes

`.local` is the default, not the only option. **Settings → Domain suffixes** takes a list, and
every service answers on all of them at once — `plex.local`, `plex.home.arpa` and `plex.lan` can
all reach the same container. The first suffix in the list is the "primary": it is what the
dashboard links to and what the admin panel displays.

There is one thing that makes `.local` special:

> **Only `.local` resolves by itself.** mDNS is defined for the `.local` domain and nothing else
> ([RFC 6762 §3](https://www.rfc-editor.org/rfc/rfc6762#section-3)). Clients never send lookups for
> other suffixes to the multicast group, so the responder deliberately only claims `.local` names.

Every other suffix works exactly as well for routing — Localizer matches the `Host` header either
way — but something has to answer the name lookup. That is **one wildcard record**, not one per
service. The settings screen shows you the exact record to create:

```
*.home.arpa   A   192.168.254.20
```

Add that in Pi-hole (Local DNS → DNS Records), AdGuard Home (Filters → DNS rewrites), or your
router, and every service you ever add is covered without touching DNS again.

### Choosing one

| Suffix | Resolves itself | Notes |
|---|---|---|
| `local` | **Yes**, via mDNS | Zero setup. Android support is inconsistent. |
| `home.arpa` | No | Reserved for home networks by [RFC 8375](https://www.rfc-editor.org/rfc/rfc8375). The formally correct choice. |
| `internal` | No | Reserved for private use by ICANN in 2024. Safe and short. |
| `lan`, `home`, `box` | No | Common conventions, not delegated publicly. Fine in practice. |
| `dev`, `app`, `zip`, `mov` | No | **Do not use.** See below. |

A practical combination is `local` primary with `home.arpa` alongside: Apple and Windows machines
get zero-config names, and anything with patchy mDNS (Android, some IoT devices) uses the DNS
suffix instead.

### Suffixes to avoid

`.dev`, `.app`, `.zip`, `.mov`, `.page` and the rest of Google's TLDs are on the
[HSTS preload list](https://hstspreload.org/) — **browsers force HTTPS on the entire zone before a
request is even sent**. A plain-HTTP proxy on those names cannot work, and no amount of
configuration will fix it. Localizer warns you if you try.

Inventing a suffix like `.nas` also works today but is a bet that it never becomes a real TLD.
`.internal` and `.home.arpa` exist precisely so you do not have to make that bet.

### Client support for `.local`

| Platform | Works out of the box? |
|---|---|
| macOS, iOS, iPadOS | Yes — mDNS is built in |
| Windows 10 (1703+) and Windows 11 | Yes |
| Linux | Yes, if `avahi-daemon` / `nss-mdns` is installed (most desktops ship it) |
| Android | **Partial** — Chrome on Android resolves `.local` inconsistently |
| Older Windows | Needs Apple Bonjour installed |

---

## Troubleshooting

**`.local` names don't resolve at all.**
Check the System tab. If Advertised IP is `172.17.x.x` you are on the Docker bridge — see
installation step 1. If the mDNS responder says *stopped*, port 5353 is already claimed on the
host; giving the container its own IP on `br0` resolves that too, since it gets its own network
stack.

**Every tile shows offline, but the apps work at their IP addresses.**
Localizer cannot reach its own host — installation step 2. Run
`docker network connect bridge localizer` and install the boot script so it survives.

**It worked, then every tile went offline after I pressed Apply.**
Apply recreates the container, which drops the bridge attachment. The boot script restores it at
the next array start; run it once by hand from User Scripts to fix it now.

**Refresh from Unraid says Localizer cannot see Docker.**
The Docker socket is not mapped in — installation step 3.

**The name resolves but the page doesn't load.**
Localizer is reachable and the container behind it isn't. The error page names the exact address
it tried. Check the dashboard's status dot and use **Test connection** in the edit form.

**The app loads but looks broken, or login bounces you out.**
Turn off **Preserve Host header** for that service. Some apps compare the `Host` header against a
configured base URL and get upset.

**The app answers `400 Bad Request`.**
Turn off **Send X-Forwarded headers**. Home Assistant rejects them until its `trusted_proxies` is
configured; ownCloud and Nextcloud answer 400 until the `.local` name is in `trusted_domains`.

**Port 80 won't bind.**
Something else has it — on Unraid that is the webGUI. Give the container its own IP on `br0`.

---

## Development

```bash
npm start           # CONFIG_DIR=/config, port 80
npm run dev         # CONFIG_DIR=./data, port 8088
npm test            # no network or Docker required
```

```
src/
├── server.js              routing: Host header → proxy, otherwise the admin app
├── lib/
│   ├── config.js          load/save/validate config.json
│   ├── categories.js      create, rename, delete and order categories
│   ├── discovery.js       Docker containers → proposed tiles, and the comparison
│   ├── docker.js          read-only Docker Engine client over the unix socket
│   ├── auth.js            scrypt passwords, HMAC session cookies, login throttling
│   ├── proxy.js           HTTP forwarding, WebSocket upgrades, redirect rewriting
│   ├── mdns.js            RFC 6762 responder — DNS wire format, announcements
│   ├── icons.js           Community Applications icon index, search, local cache
│   ├── health.js          TCP probes, host-reachability diagnosis
│   └── netinfo.js         interface detection, Docker-bridge detection
├── routes/api.js          REST API
└── public/                dashboard, admin panel, login (no build step)
```

Tests run discovery against a synthetic Docker inventory served from a fake socket, so they need
neither Docker nor network access.

Everything is stored in `/config`:

```
config.json        routes, categories, settings, your password hash
icon-index.json    cached catalogue index (~600 KB, rebuilt weekly)
icons/             locally cached icon images
```

### Security notes

This is a LAN tool and is designed as one. Passwords are hashed with scrypt; sessions are
HMAC-signed, `HttpOnly`, `SameSite=Lax` cookies; failed logins are throttled per IP. Traffic
between clients and Localizer is **plain HTTP** — `.local` names cannot get a public TLS
certificate, so there is nothing to be gained from a self-signed one here. Do not expose this
container to the internet.

The Docker socket is optional and read from, never written to — but see installation step 3 for
what mapping it in means.

The dashboard is readable without signing in by default, so it works as a one-click launcher;
it deliberately does not expose upstream addresses to anonymous visitors. Turn on **Require
sign-in for the dashboard** in Settings if you would rather it were private.

## Licence

MIT
