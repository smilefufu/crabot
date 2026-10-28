#!/bin/sh
set -eu
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for ip in $EVAL_PROVIDER_IPS; do
  case "$ip" in *[!0-9.]*|'') exit 70;; esac
  iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -j ACCEPT
done
iptables -P OUTPUT DROP
python3 - <<'PY'
import socket
s=socket.socket();s.settimeout(2)
try:
 s.connect(('1.1.1.1',443))
 raise SystemExit('Egress isolation failed')
except (TimeoutError,OSError):pass
finally:s.close()
PY
printf 'CRABOT_EVAL_GATE egress=provider-only capabilities=dropped\n' >&2
exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"
