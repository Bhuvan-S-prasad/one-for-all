# syntax=docker/dockerfile:1
#
# The agents' computer (ADR-0025, superseding ADR-0009's image choice): Debian
# slim with Chromium, a light desktop on a virtual display (ADR-0040), a shell
# and files, run by a small service (`server.mjs`). The same image also runs the egress proxy
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
#
# The light desktop on each agent's screen (ADR-0040): openbox (windows),
# tint2 (the dock), pcmanfm (desktop icons and files), xterm with tmux (the
# terminal), mousepad (text), abiword and gnumeric (Word and Excel files),
# feh (images),
# x11vnc (watching), xdotool and scrot (input and screenshots, ADR-0041),
# and dbus with the AT-SPI bridge (the accessibility tree of desktop apps).
#
# Python (ADR-0042): pip and venv, so each agent installs packages into its
# own ~/.venv, and openpyxl and python-docx for Excel and Word files.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    bash ca-certificates chromium curl file fonts-dejavu-core fonts-liberation \
    fonts-noto-core git jq less procps python3 tini unzip util-linux xauth xvfb zip \
    python3-docx python3-openpyxl python3-pip python3-venv \
    abiword adwaita-icon-theme at-spi2-core dbus feh gnumeric libatk-adaptor mousepad \
    openbox pcmanfm python3-pyatspi scrot tint2 tmux x11vnc xdotool xterm \
  && rm -rf /var/lib/apt/lists/* \
  && dbus-uuidgen --ensure=/etc/machine-id

# The desktop's look and launchers (ADR-0040). Openbox keeps Debian's
# defaults but one desktop, our theme and font, no animation, and Chromium
# maximised.
COPY desktop/themerc /usr/share/themes/One-for-All/openbox-3/themerc
COPY desktop/gtkrc /etc/gtk-2.0/one-for-all.gtkrc
COPY desktop/tint2rc /etc/xdg/tint2/one-for-all.tint2rc
COPY desktop/pcmanfm.conf desktop/desktop-items-0.conf /etc/xdg/pcmanfm/one-for-all/
COPY desktop/libfm.conf /etc/xdg/libfm/libfm.conf
COPY desktop/tmux.conf /etc/tmux.conf
COPY desktop/applications/ /usr/share/applications/
COPY --chmod=755 desktop/one-for-all-terminal desktop/one-for-all-browser desktop/one-for-all-run /usr/local/bin/
COPY desktop/wallpaper.mjs /tmp/wallpaper.mjs
RUN mkdir -p /usr/share/backgrounds \
  && node /tmp/wallpaper.mjs /usr/share/backgrounds/one-for-all.png \
  && rm /tmp/wallpaper.mjs \
  && sed -i \
    -e 's|<name>Clearlooks</name>|<name>One-for-All</name>|' \
    -e 's|<name>sans</name>|<name>Noto Sans</name>|g' \
    -e 's|<number>4</number>|<number>1</number>|' \
    -e 's|<animateIconify>yes</animateIconify>|<animateIconify>no</animateIconify>|' \
    -e 's|</applications>|  <application class="Chromium"><maximized>yes</maximized></application>\n</applications>|' \
    /etc/xdg/openbox/rc.xml \
  && grep -q '<name>One-for-All</name>' /etc/xdg/openbox/rc.xml \
  && grep -q '<number>1</number>' /etc/xdg/openbox/rc.xml \
  && grep -q 'class="Chromium"' /etc/xdg/openbox/rc.xml

# Agents' homes (one private directory each) and the shared workspace. Both
# are volumes; the service fixes ownership on start.
#
# Each agent slot also gets a passwd and group entry (agent0 = uid 10001, up
# to the service's 500 agents): the root file system is read-only, and the
# desktop's session bus refuses a uid with no name.
RUN mkdir -p /home/agents /workspace \
  && groupadd --gid 10000 agents \
  && chown root:agents /workspace \
  && chmod 2770 /workspace \
  && for slot in $(seq 0 499); do \
    uid=$((10001 + slot)); \
    echo "agent${slot}:x:${uid}:${uid}::/home/agents/${uid}:/bin/bash" >> /etc/passwd; \
    echo "agent${slot}:x:${uid}:" >> /etc/group; \
  done

COPY server.mjs egress.mjs /opt/sandbox/

ENV SANDBOX_PORT=7070 \
  LANG=C.UTF-8
EXPOSE 7070
WORKDIR /workspace

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.SANDBOX_PORT||7070)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/sandbox/server.mjs"]
