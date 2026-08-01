# busybox userland, musl, ash. The odd one out on purpose: its `ls` and its
# sshd defaults are not what the other four do, which is the point of having it.
FROM alpine:3.20
# `adduser -D` leaves `!` in the shadow field, and Alpine's sshd is built
# without PAM so it does its own locked-account check and refuses the login —
# key or not. The other four distributions hand that check to PAM, which does
# not mind, which is why this bites here and only here.
RUN apk add --no-cache openssh \
 && adduser -D deploy \
 && adduser -D ops \
 && sed -i 's/^\(deploy\|ops\):!:/\1:*:/' /etc/shadow
COPY sshd_lab.conf /tmp/sshd_lab.conf
RUN cat /tmp/sshd_lab.conf >> /etc/ssh/sshd_config \
 && sed -i 's/^AllowTcpForwarding no/#&/' /etc/ssh/sshd_config \
 && sed -i 's/^GatewayPorts no/#&/' /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
