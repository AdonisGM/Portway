# lab — five throwaway servers

Five SSH servers in Docker, on five different distributions, for working on
Portway against something real instead of a mock.

```
./up.sh        # make the key if there isn't one, build, start, wait, report
./import.sh    # put the five into Portway (restart the app to see them)
./down.sh      # stop and remove them
./down.sh --purge   # …and remove their rows and their known_hosts entries
```

| machine | port | user | group | distribution |
| --- | --- | --- | --- | --- |
| `lab-alpine` | 2201 | `deploy` | prod | Alpine 3.20 |
| `lab-debian` | 2202 | `webops` | prod | Debian 12 |
| `lab-ubuntu` | 2203 | `ubuntu` | staging | Ubuntu 24.04 |
| `lab-alma` | 2204 | `svc` | dev | AlmaLinux 9 |
| `lab-suse` | 2205 | `root` | home | openSUSE Leap 15.6 |

`machines.sh` is the one table all of this reads, so a machine cannot be
described one way in the compose file and another in the import.

## Why five distributions and not five Alpines

They disagree about the things the app has to get right, and each disagreement
has already caught something:

- **Alpine** is busybox and musl, its `ls -l` is not GNU's, and its sshd ships
  with `AllowTcpForwarding no` — the default that made a tunnel report `active`
  while refusing every connection. Its `adduser` also leaves the account locked,
  and its sshd is built without PAM so it enforces that itself: key auth is
  refused outright. The other four hand that check to PAM, which does not mind.
- **Debian and Ubuntu** need `/run/sshd` to exist before sshd will start, and
  `/run` is a tmpfs, so it has to be made at boot rather than at build.
- **AlmaLinux** is the RHEL layout — a different `sshd_config`, `dnf`, and the
  file ownership conventions that go with it.
- **openSUSE** is the one reached as `root`, so there is a case where the
  account logged in owns everything it can see.

## What is in each machine

`~/files` holds a small tree, deliberately owned by more than one account:

```
files/logs/          three 4 KB files, for deleting a folder that is not empty
files/os-release     what the machine thinks it is
files/ops-only.txt   owned by `ops`  — a name the server can resolve
files/orphan.txt     owned by 4242:4243 — an id it cannot
```

Those last two are the two cases the SFTP Owner column has to tell apart: a
name it got from the server, and a number it could not turn into one.

## Tunnels

The five share a Docker network, so any machine is a tunnel target for any
other and no extra software is needed. A local forward through `lab-alpine` to
`debian:22` reaches the Debian machine's own sshd:

```
listen   127.0.0.1:29001
target   debian:22          (the service name, resolved inside the network)
via      lab-alpine
```

`ssh -p 29001 webops@127.0.0.1 -i lab/keys/lab_ed25519` then lands on Debian,
having gone through Alpine. Service names are `alpine`, `debian`, `ubuntu`,
`almalinux`, `opensuse`.

## The key

`keys/lab_ed25519`, made by `up.sh` on first run and **not** committed —
`.gitignore` in this folder keeps it out. It is throwaway and it is still a
private key. Delete the folder and `up.sh` makes a new one; the machines pick it
up at their next start, since it is mounted rather than baked in.

Host keys are regenerated every time a container is created, so re-creating the
lab makes `known_hosts` disagree with what answers on those ports. `down.sh
--purge` clears those entries; without it, the app refuses the connection and
says so, which is the behaviour you want and a nuisance in a lab.
