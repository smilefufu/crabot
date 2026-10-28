#!/usr/bin/env bash
# Build-time only. Sources must already have passed the pinned SHA-256 checks.
set -euo pipefail
bash_archive=$1
git_archive=$2
destination=$3
workspace=$4
jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 2)
if [ "$jobs" -gt 8 ]; then jobs=8; fi
mkdir -p "$workspace/bash" "$workspace/git" "$destination/bin" "$destination/licenses/sources"
tar -xf "$bash_archive" -C "$workspace/bash" --strip-components=1
tar -xf "$git_archive" -C "$workspace/git" --strip-components=1
if [ "$(uname -s)" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=14.0
  export CFLAGS="-O2 -mmacosx-version-min=14.0"
fi
(
  cd "$workspace/bash"
  ./configure --prefix="$destination/bash" --disable-nls --disable-readline --without-bash-malloc
  make -j"$jobs"
  cp bash "$destination/bin/bash"
)
(
  cd "$workspace/git"
  flags=(NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_RUST=1 NO_DARWIN_PORTS=1 NO_OPENSSL=1 CURL_CONFIG= CURL_LIBCURL=-lcurl prefix="$destination/git")
  make -j"$jobs" "${flags[@]}"
  # Relative aliases survive relocation and avoid expanding each hard link into
  # another complete Git binary in app copies and ZIP update packages.
  make "${flags[@]}" INSTALL_SYMLINKS=1 install
)
# The wrapper keeps Git's helpers and templates relocatable after app installation.
cat > "$destination/bin/git" <<'WRAPPER'
#!/bin/sh
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
export GIT_EXEC_PATH="$root/git/libexec/git-core"
export GIT_TEMPLATE_DIR="$root/git/share/git-core/templates"
if [ -d "$root/lib" ]; then
  export LD_LIBRARY_PATH="$root/lib:$LD_LIBRARY_PATH"
fi
exec "$root/git/bin/git" "$@"
WRAPPER
chmod 755 "$destination/bin/git" "$destination/bin/bash"
cp "$bash_archive" "$git_archive" "$destination/licenses/sources/"
cp "$workspace/bash/COPYING" "$destination/licenses/Bash-COPYING"
cp "$workspace/git/COPYING" "$destination/licenses/Git-COPYING"
# Linux private dependencies must not replace the host loader or glibc.
if [ "$(uname -s)" = Linux ]; then
  mkdir -p "$destination/lib"
  find "$destination/git" "$destination/bin/bash" -type f -perm /111 -print0 |
    while IFS= read -r -d '' executable; do
      ldd "$executable" 2>/dev/null || true
    done |
    awk '/=> \// {print $3}' | sort -u |
    while IFS= read -r library; do
      case "$(basename "$library")" in
        libc.so.*|libm.so.*|libpthread.so.*|libdl.so.*|librt.so.*|libresolv.so.*|libutil.so.*|ld-linux*) continue ;;
      esac
      cp -L "$library" "$destination/lib/"
    done
else
  # Homebrew/MacPorts libraries cannot accidentally become runtime prerequisites.
  if otool -L "$destination/git/bin/git" "$destination/bin/bash" | sed '1d' | grep -E '/(opt/homebrew|usr/local|opt/local)/'; then
    printf '%s\n' 'Non-system macOS runtime dependency detected' >&2
    exit 1
  fi
fi
