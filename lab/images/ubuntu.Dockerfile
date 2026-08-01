# 24.04 ships with a `ubuntu` user at uid 1000 already, so this one is reached
# as the account the image itself made rather than one invented for the lab.
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m ops
COPY sshd_lab.conf /tmp/sshd_lab.conf
RUN cat /tmp/sshd_lab.conf >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
