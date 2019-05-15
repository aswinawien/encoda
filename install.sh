#!/usr/bin/env bash

# A script to download and install the latest version

OS=$(uname)
if [[ "$OS" == "Linux" || "$OS" == "Darwin" ]]; then
    case "$OS" in
        'Linux')
            PLATFORM="linux-x64"
            if [ -z "$1" ]; then
                VERSION=$(curl --silent "https://api.github.com/repos/stencila/convert/releases/latest" | grep -Po '"tag_name": "\K.*?(?=")')
            else
                VERSION=$1
            fi
            INSTALL_PATH="$HOME/.local/bin/"
            ;;
        'Darwin')
            PLATFORM="macos-x64"
            if [ -z "$1" ]; then
                VERSION=$(curl --silent "https://api.github.com/repos/stencila/convert/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
            else
                VERSION=$1
            fi
            INSTALL_PATH="/usr/local/bin/"
            ;;
    esac
    curl -Lo /tmp/convert.tar.gz https://github.com/stencila/convert/releases/download/$VERSION/convert-$PLATFORM.tar.gz
    tar xvf /tmp/convert.tar.gz
    mkdir -p $INSTALL_PATH
    mv -f stencila-convert $INSTALL_PATH
    rm -f /tmp/convert.tar.gz
else
    echo "Sorry, I don't know how to install on this OS, please see https://github.com/stencila/convert#install"
fi