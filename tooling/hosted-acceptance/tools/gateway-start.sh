#!/bin/sh
set -eu
umask 077
# Kernel boundary installed before Node opens a request listener. No gateway DNS.
node -e 'const c=require("/tools/config.cjs").load(); for(const a of new Set(Object.values(c.upstreams).flat()))console.log(a)' > /tmp/allowed-ips
iptables -P OUTPUT DROP
iptables -P INPUT DROP
iptables -P FORWARD DROP
iptables -F OUTPUT
iptables -F INPUT
ip6tables -P OUTPUT DROP
ip6tables -P INPUT DROP
ip6tables -P FORWARD DROP
ip6tables -F OUTPUT
ip6tables -F INPUT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
while IFS= read -r ip; do iptables -A OUTPUT -p tcp -d "$ip" --dport 443 -m conntrack --ctstate NEW -j ACCEPT; done < /tmp/allowed-ips
iptables-save > /evidence/gateway-ipv4.rules
ip6tables-save > /evidence/gateway-ipv6.rules
chmod 0644 /evidence/gateway-ipv4.rules /evidence/gateway-ipv6.rules
rm /tmp/allowed-ips
exec setpriv --reuid=501 --regid=20 --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs node /tools/gateway.cjs
