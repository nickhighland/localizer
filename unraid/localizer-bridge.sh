#!/bin/bash
# Attaches Localizer to Docker's default bridge network.
#
# Localizer lives on br0 so it has its own LAN address and can send and receive
# the multicast that mDNS needs. br0 is a macvlan or ipvlan network, and a child
# of either cannot reach its own parent host — so without a second interface,
# every service published on the host is invisible to it and every tile reads
# as offline.
#
# A network attachment survives restarts and reboots, but not a container
# recreate, which is what pressing Apply on the template does. Install this with
# the User Scripts plugin, scheduled "At Startup of Array", and it heals itself.
#
# Usage: localizer-bridge.sh [container-name]   (default: localizer)

CONTAINER="${1:-localizer}"

# Docker may still be starting when the array comes up.
for _ in $(seq 1 30); do
  docker info >/dev/null 2>&1 && break
  sleep 2
done

for _ in $(seq 1 30); do
  docker inspect "$CONTAINER" >/dev/null 2>&1 && break
  sleep 2
done

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "$CONTAINER is not present; nothing to do."
  exit 0
fi

if docker inspect -f '{{json .NetworkSettings.Networks}}' "$CONTAINER" | grep -q '"bridge"'; then
  echo "$CONTAINER is already on the bridge network."
  exit 0
fi

if docker network connect bridge "$CONTAINER"; then
  echo "Attached $CONTAINER to the bridge network."
else
  echo "Failed to attach $CONTAINER to the bridge network." >&2
  exit 1
fi
