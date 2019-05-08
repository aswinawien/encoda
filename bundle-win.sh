#!/usr/bin/env bash

# A script to rename, code sign and zip the windows binary created by `pkg`
# so it's ready for release. This is designed to run on Travis CI where
# the env vars for decrypting `win-cert.p12.enc` and `WIN_CERT_PASSWORD`
# are available

osslsigncode sign \
  -pkcs12 "win-cert.p12" \
  -pass "$WIN_CERT_PASSWORD" \
  -n "Convert" \
  -i "https://stenci.la" \
  -t "http://timestamp.comodoca.com/authenticode" \
  -in "bin/stencila-convert-win.exe" \
  -out "bin/stencila-convert.exe"

zip -j bin/convert-win-x64.zip bin/stencila-convert.exe
