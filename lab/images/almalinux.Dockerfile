# The RHEL side: dnf, and an sshd_config laid out differently from Debian's.
FROM almalinux:9
RUN dnf -y install openssh-server \
 && dnf clean all \
 && useradd -m svc \
 && useradd -m ops
COPY sshd_lab.conf /tmp/sshd_lab.conf
RUN cat /tmp/sshd_lab.conf >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
