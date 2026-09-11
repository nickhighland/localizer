# Submitting to Community Applications

Everything on this side is ready. CA registration is a **forum post**, not a pull request, so the
last step needs your Unraid forum account — it can't be automated.

> **Already posted under the old name?** The repository moved from
> `nickhighland/unraid-reverse-proxy` to `nickhighland/localizer`. GitHub redirects the old address,
> but CA's scanner should be given the new one: reply in the same thread with the updated URL.

## How CA actually works

CA does not host templates. It keeps a list of ~1,190 *maintainer repositories* and rescans them
regularly, generating `applicationFeed.json`. You register a repository once; every template in it
is picked up, and every later change flows through automatically without another submission.

That means: **you submit the repository, not the app.** Future versions need no further action.

## Pre-flight

| Check | Status |
|---|---|
| Template is well-formed XML, no unbalanced tags, no unescaped `&` | ✅ |
| All required fields present (Name, Repository, Registry, Network, Support, Project, Overview, Category, Icon, WebUI, TemplateURL) | ✅ |
| Categories exist in CA's `categoryList.json` — `Network:Proxy`, `Network:DNS`, `Tools:Utilities` | ✅ |
| Every `<Config>` block has Name/Target/Type/Mode/Display/Required/Mask | ✅ |
| Image is public and pulls anonymously | check after the 2.0.0 release |
| Image is multi-arch (linux/amd64 + linux/arm64) | check after the 2.0.0 release |
| Icon URL returns a real PNG | ✅ |
| `TemplateURL` resolves to the raw XML | check after the rename |
| Support URL is reachable | ✅ |

## The post to make

Go to the Unraid forums thread **"Community Applications — Add your repository here"**
(<https://forums.unraid.net/topic/38582-plug-in-community-applications/>, or search the forum for
that title — CA's maintainer pins the current thread). Post this:

> **Repository:** https://github.com/nickhighland/localizer
>
> **Maintainer:** nickhighland
>
> **Application:** Localizer — gives every Docker container a `.local` name.
>
> It runs a reverse proxy that routes by Host header together with an mDNS responder, so
> `sonarr.local` and friends resolve across the LAN with no DNS configuration on the router or on
> any client. It can read the Docker socket to find running containers and keep its tiles in step
> with them, and it has a launch dashboard with live status, categories, and in-place editing.
>
> Template: `unraid/localizer.xml`
> Image: `ghcr.io/nickhighland/localizer` (public, amd64 + arm64)
> Support: https://github.com/nickhighland/localizer/issues
>
> Notes for reviewers:
>
> - `Network` is `br0` because the container needs its own LAN IP: port 80 on the host belongs to
>   the webGUI, and mDNS needs real multicast.
> - The Overview asks the user to attach the default bridge once
>   (`docker network connect bridge localizer`), because a macvlan or ipvlan container cannot reach
>   its own host. The repository ships a User Scripts boot script for it, and the app reports the
>   missing attachment in its log and System tab rather than failing silently.
> - The Docker socket path is optional and read-only. The Overview and its description state plainly
>   that holding the socket means trusting the container.

## What happens next

1. CA's maintainer adds the repository to the scan list (usually a few days).
2. The next feed rebuild picks up the template; the app appears in **Apps** in Unraid.
3. Later releases need nothing: tag a new version, and the `:latest` image plus any template edits
   are picked up on the next scan.

## If it is rejected

The usual reasons and what to do:

- **"Needs a support thread."** CA prefers an Unraid forum support thread over GitHub issues.
  Create one in *Docker Containers* → *Docker Engine*, then change `<Support>` to that URL.
- **"Do not default to br0."** Some reviewers dislike templates that require a custom network.
  The honest answer is that this app cannot work on the default bridge — mDNS needs multicast to
  reach the LAN. Point at the Overview, which explains it up front.
- **"Do not map the Docker socket by default."** Change that `<Config>` to `Display="advanced"` and
  leave its value empty; discovery simply stays off until someone maps it.
