#!/bin/bash
# Exercise the published Linux ABI and installer on the confirmed distro versions.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
archive=$1
node_root=$(dirname "$(dirname "$(command -v node)")")
uv_bin=$(readlink -f "$(command -v uv)")
for image in ubuntu:24.04 debian:12 debian:13; do
  docker run --rm \
    --mount "type=bind,src=$repo,dst=/workspace,readonly" \
    --mount "type=bind,src=$node_root,dst=/opt/node,readonly" \
    --mount "type=bind,src=$(dirname "$uv_bin"),dst=/opt/uv,readonly" \
    -e "CRABOT_CI_ARCHIVE=/workspace/$(basename "$archive")" \
    -e CRABOT_CI_SKIP_SOURCE=1 "$image" bash -euc '
      export DEBIAN_FRONTEND=noninteractive
      apt-get update -qq
      apt-get install -y -qq --no-install-recommends bash ca-certificates curl tar gzip libstdc++6 procps zsh
      ln -s /opt/node/bin/node /usr/local/bin/node
      ln -s /opt/uv/uv /usr/local/bin/uv
      export PATH=/opt/node/bin:/opt/uv:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
      node /workspace/.github/scripts/smoke-installer.mjs "$CRABOT_CI_ARCHIVE"
    '
done
