FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends systemd systemd-sysv dbus dbus-user-session sudo python3 procps util-linux ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -u 1000 -s /bin/bash user && mkdir -p /var/lib/systemd/linger && touch /var/lib/systemd/linger/user && systemctl mask systemd-logind.service getty.target console-getty.service && systemctl set-default multi-user.target
COPY source /opt/hearth
CMD ["/lib/systemd/systemd"]
