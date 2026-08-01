#!/usr/bin/env bash
# The one table. Everything else in this folder reads it, so a machine cannot
# be described one way in the compose file and another in the import.
#
#   port  name        user    group    distribution
LAB_MACHINES=(
  '2201 lab-alpine deploy prod    Alpine-3.20'
  '2202 lab-debian webops prod    Debian-12'
  '2203 lab-ubuntu ubuntu staging Ubuntu-24.04'
  '2204 lab-alma   svc    dev     AlmaLinux-9'
  '2205 lab-suse   root   home    openSUSE-Leap-15.6'
)
