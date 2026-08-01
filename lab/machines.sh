#!/usr/bin/env bash
# The one table. Everything else in this folder reads it, so a machine cannot
# be described one way in the compose file and another in the import.
#
#   port  name        user    group    distribution
# The key lives in ~/.ssh, not beside these files.
#
# This folder is inside the repository, and the repository is somewhere under
# ~/Documents — which macOS gates behind a permission prompt. An app reading a
# key from there blocks on that prompt, and because the app is ad-hoc signed the
# grant does not survive a rebuild, so it asks again every time. ~/.ssh is not
# gated, and is where a key belongs anyway.
LAB_KEY="$HOME/.ssh/portway-lab_ed25519"

LAB_MACHINES=(
  '2201 lab-alpine deploy prod    Alpine-3.20'
  '2202 lab-debian webops prod    Debian-12'
  '2203 lab-ubuntu ubuntu staging Ubuntu-24.04'
  '2204 lab-alma   svc    dev     AlmaLinux-9'
  '2205 lab-suse   root   home    openSUSE-Leap-15.6'
)
