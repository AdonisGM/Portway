#!/usr/bin/env bash
# Cargo's runner for the dev app on macOS (set by dev.sh): signs the freshly
# built binary with the local signing certificate, then runs it.
#
# An unsigned (ad-hoc) binary has a new identity after every build, so macOS
# asks for the Keychain password again for each item Portway keeps there. With
# the same certificate and identifier the identity stays the same across
# builds, and across the release build (see "Ký bản build trên Mac" in the README).
#
# Anything else Cargo runs through here (test binaries) is run as it is, and so
# is the app when the certificate does not exist on this machine.
set -u

CERT="Portway Local Signing"
bin="$1"

if [ "$(basename "$bin")" = "portway" ] && security find-identity -p codesigning 2>/dev/null | grep -q "\"$CERT\""; then
  codesign --force --sign "$CERT" --identifier com.portway.app --timestamp=none "$bin" 2>/dev/null \
    || echo "dev-sign-run: could not sign with \"$CERT\"; running unsigned (Keychain will ask again)" >&2
fi

exec "$@"
