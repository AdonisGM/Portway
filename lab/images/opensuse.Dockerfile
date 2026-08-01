# zypper, and the one machine reached as root — so the app has a case where the
# account it logs in as owns everything it can see.
FROM opensuse/leap:15.6
RUN zypper --non-interactive install openssh \
 && zypper clean -a \
 && useradd -m ops
COPY sshd_lab.conf /tmp/sshd_lab.conf
RUN cat /tmp/sshd_lab.conf >> /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
