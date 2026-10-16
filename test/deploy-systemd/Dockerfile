FROM debian:bookworm-slim
ENV container=docker
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    systemd dbus libpam-systemd python3 curl nodejs npm git util-linux ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY pi/dashboard/ /opt/hearth/pi/dashboard/
COPY test/deploy-systemd/verify.py /opt/hearth/verify.py
COPY test/deploy-systemd/boot.sh /opt/hearth/boot.sh
STOPSIGNAL SIGRTMIN+3
CMD ["/bin/bash", "/opt/hearth/boot.sh"]
