FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/bash webops \
 && useradd -m ops
COPY sshd_lab.conf /tmp/sshd_lab.conf
RUN cat /tmp/sshd_lab.conf >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
