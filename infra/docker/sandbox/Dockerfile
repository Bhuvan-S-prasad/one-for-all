# syntax=docker/dockerfile:1
#
# The agents' computer (ADR-0025, superseding ADR-0009's image choice): Debian
# slim with Chromium, a virtual display, a shell and files, run by a small
# service (`server.mjs`). The same image also runs the egress proxy
# (`egress.mjs`), the sandbox's only way out (M3.02).
#
#   docker build -t one-for-all-sandbox infra/docker/sandbox
#   docker buildx build --platform linux/amd64,linux/arm64 infra/docker/sandbox
#
# Everything here is plain Debian packages and dependency-free Node scripts,
# so the image builds the same on x64 and arm64 (Raspberry Pi, Oracle ARM).
#
# Hardening lives in Compose, where it is enforced: read-only root file
# system, all capabilities dropped except CHOWN, SETUID, SETGID and KILL,
# no-new-privileges, CPU, memory and process limits, no Docker socket and no
# host mounts. The service runs as root only to start each agent's processes
# under that agent's own unprivileged user; agent code never runs as root.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim

# chromium: the browser agents drive over CDP (Debian builds it for arm64 too).
# xvfb: a screen per agent, so the browser is real and can be watched (M3.07).
# util-linux gives setpriv, which starts agent processes under their own user.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash ca-certificates chromium curl file fonts-liberation fonts-noto-core git \
    jq less procps python3 tini unzip util-linux xauth xvfb zip \
  && rm -rf /var/lib/apt/lists/*

# Agents' homes (one private directory each) and the shared workspace. Both
# are volumes; the service fixes ownership on start.
RUN mkdir -p /home/agents /workspace \
  && groupadd --gid 10000 agents \
  && chown root:agents /workspace \
  && chmod 2770 /workspace

COPY server.mjs egress.mjs /opt/sandbox/

ENV SANDBOX_PORT=7070 \
  LANG=C.UTF-8
EXPOSE 7070
WORKDIR /workspace

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SANDBOX_PORT||7070)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/sandbox/server.mjs"]
