#!/bin/sh
set -eu
umask 077
ulimit -c 0
mkdir -p /profile/home/.pki/nssdb /profile/chromium
if [ ! -f /profile/home/.pki/nssdb/cert9.db ]; then certutil -N --empty-password -d sql:/profile/home/.pki/nssdb; fi
certutil -A -d sql:/profile/home/.pki/nssdb -n acceptance-browser-only -t 'C,,' -i /tls/cert.pem
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
sleep 1
node /tools/tls-shim.cjs >/dev/null 2>&1 &
exec node /tools/browser.cjs
