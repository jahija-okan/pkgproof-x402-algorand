#!/usr/bin/env bash
#
# Post-deploy checks for the Algorand x402 Worker: path gate, free-proxy
# allowlist, paywall-bypass attempts, and the paid end-to-end flow.
#
# Free checks run first. The paid flow costs 2x the route price ($0.10 on
# Mainnet).
#
#   ALGO_PRIVATE_KEY=<base64> ./verify-deploy.sh
#
# Testnet by default. For Mainnet, name both explicitly:
#
#   ALGOD_URL=https://mainnet-api.algonode.cloud ASSET_ID=31566704 \
#     ALGO_PRIVATE_KEY=<base64> ./verify-deploy.sh
#
# Exits non-zero if anything is wrong.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1

WORKER=${WORKER:-https://x402-algo.pkgproof.net}
APEX=${APEX:-https://pkgproof.net}
# The origin's address, deliberately not in this repo. Only needed for the
# direct-to-origin bypass probe in section 4.
ORIGIN_IP=${ORIGIN_IP:-${PKGPROOF_ORIGIN_IP:?export PKGPROOF_ORIGIN_IP or ORIGIN_IP}}

pass=0
fail=0

# probe <expected> <method> <url> [extra curl args...]
probe() {
	local expected=$1 method=$2 url=$3
	shift 3
	local got
	got=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' \
		--max-time 20 -X "$method" "$url" "$@")

	if [ "$got" = "$expected" ]; then
		printf '  \033[32mok\033[0m   %-3s %s\n' "$got" "$url"
		pass=$((pass + 1))
	else
		printf '  \033[31mFAIL\033[0m %-3s %s  (wanted %s)\n' "$got" "$url" "$expected"
		fail=$((fail + 1))
	fi
}

# probe_any "<code> <code>..." <method> <url> [extra curl args...]
probe_any() {
	local expected=$1 method=$2 url=$3
	shift 3
	local got
	got=$(curl -s --path-as-is -o /dev/null -w '%{http_code}' \
		--max-time 20 -X "$method" "$url" "$@")

	if [[ " $expected " == *" $got "* ]]; then
		local note="refused"
		[ "$got" = "000" ] && note="unreachable"
		printf '  \033[32mok\033[0m   %-3s %s  (%s)\n' "$got" "$url" "$note"
		pass=$((pass + 1))
	else
		printf '  \033[31mFAIL\033[0m %-3s %s  (wanted one of: %s)\n' "$got" "$url" "$expected"
		fail=$((fail + 1))
	fi
}

# probe_refused_here <method> <url> [extra curl args...]
# Confirms the Worker's own 404 (JSON body), not one forwarded from the origin.
probe_refused_here() {
	local method=$1 url=$2
	shift 2
	local got body
	body=$(curl -s --path-as-is -w '\n%{http_code}' \
		--max-time 20 -X "$method" "$url" "$@")
	got=${body##*$'\n'}
	body=${body%$'\n'*}

	if [ "$got" = "404" ] && [[ "$body" == *'"not_found"'* ]]; then
		printf '  \033[32mok\033[0m   %-3s %s  (refused at the edge)\n' "$got" "$url"
		pass=$((pass + 1))
	else
		printf '  \033[31mFAIL\033[0m %-3s %s  (wanted the Worker'"'"'s own 404, got body: %s)\n' \
			"$got" "$url" "${body:0:60}"
		fail=$((fail + 1))
	fi
}

json=(-H 'content-type: application/json' -d '{"ecosystem":"npm","name":"left-pad"}')

echo
echo "── an unpaid call is refused: this rail serves no free verification ──"
free=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
	-X POST "$WORKER/v1/verify" "${json[@]}")
if [ "$free" = 402 ]; then
	printf '  ok    unpaid call answered 402\n'
	pass=$((pass + 1))
elif [ "$free" = 200 ]; then
	printf '  \033[31mFAIL\033[0m unpaid call answered 200: the free tier is live on the rail that must settle\n'
	fail=$((fail + 1))
else
	printf '  \033[31mFAIL\033[0m unpaid call answered %s, expected 402\n' "$free"
	fail=$((fail + 1))
fi

echo
echo "══ 1. Only /v1/verify is payable ══"
for p in /v1/verify //v1/verify /v1/verify/; do
	probe 402 POST "$WORKER$p" "${json[@]}"
done

echo
echo "── the 402 is still discoverable ──"
terms=$(curl -sS -D /tmp/pkgproof-402-headers -X POST "$WORKER/v1/verify" "${json[@]}")
if grep -qi '^payment-required:' /tmp/pkgproof-402-headers; then
	printf '  \033[32mok\033[0m   PAYMENT-REQUIRED header present\n'
else
	printf '  \033[31mFAIL\033[0m PAYMENT-REQUIRED header missing: the Bazaar cannot catalogue this\n'
	fail=$((fail + 1))
fi
for field in '"x402Version":2' '"bazaar"' '"bodyType":"json"' '"method":"POST"' \
	'"x402-merchant"' '"logo":"https://pkgproof.net/apple-touch-icon.png"' \
	'"serviceName":"pkgproof"' '"tag":"x402-global-challenge"' \
	"\"url\":\"$WORKER/v1/verify\""; do
	if printf '%s' "$terms" | grep -qF "$field"; then
		printf '  \033[32mok\033[0m   402 carries %s\n' "$field"
	else
		printf '  \033[31mFAIL\033[0m 402 is missing %s\n' "$field"
		fail=$((fail + 1))
	fi
done
rm -f /tmp/pkgproof-402-headers

echo
echo "── only POST is sold at the paid path ──"
for m in GET HEAD PUT PATCH DELETE; do
	probe 405 "$m" "$WORKER/v1/verify"
done
if curl -sS -D - -o /dev/null --max-time 20 -X GET "$WORKER/v1/verify" |
	grep -qi '^allow: *POST'; then
	printf '  \033[32mok\033[0m   405 names the method it does sell\n'
	pass=$((pass + 1))
else
	printf '  \033[31mFAIL\033[0m 405 without an Allow: POST header\n'
	fail=$((fail + 1))
fi

echo
echo "══ 2. Everything else is refused before the origin is touched ══"
for p in /v1abc '/v1;x/verify' '/v1/verify;x=1' /v1/other /v1/ /v1 \
	/V1/verify /v1%2fverify /v1/verify%20 /nope; do
	probe 404 POST "$WORKER$p" "${json[@]}"
done
probe 404 GET "$WORKER/__x402/protected"

echo
echo "══ 3. The free allowlist still serves ══"
probe 200 GET "$WORKER/up"
probe 200 GET "$WORKER/robots.txt"
probe 200 GET "$WORKER/__x402/health"
probe 200 GET "$WORKER/.well-known/x402"
probe 200 GET "$WORKER/.well-known/x402.json"
probe 200 GET "$WORKER/favicon.ico"
probe 200 GET "$WORKER/icon.svg"
probe 200 GET "$WORKER/apple-touch-icon.png"
probe 200 GET "$WORKER/openapi.json"
probe 200 GET "$WORKER/llms.txt"

# Checked on the body, not the status: a request that reached the origin
# unpaid could also 404 there, so a status-only probe would pass either way.
for p in /up /robots.txt /openapi.json /llms.txt /.well-known/x402 /.well-known/x402.json /favicon.ico /icon.svg /apple-touch-icon.png; do
	probe_refused_here POST "$WORKER$p" "${json[@]}"
done

probe 301 GET "$WORKER/"
probe 404 POST "$WORKER/" "${json[@]}"

echo
echo "══ 4. The paywall cannot be walked around ══"
# A 200, 422 or 502 from any of these is a revenue leak.
probe 404 POST "$APEX/v1/verify" "${json[@]}"
probe 404 POST "$APEX/v1/verify" "${json[@]}" -H 'X-Origin-Secret: FORGED'
probe_any "000 404" POST "$APEX/v1/verify" "${json[@]}" \
	--resolve "pkgproof.net:443:$ORIGIN_IP" -k
probe 200 GET "$APEX/"

echo
printf '── free checks: %d passed, %d failed ──\n' "$pass" "$fail"

if [ "$fail" -ne 0 ]; then
	echo
	echo "Free checks failed. Not spending money on the paid flow."
	exit 1
fi

if [ -z "${ALGO_PRIVATE_KEY:-}" ]; then
	echo
	echo "ALGO_PRIVATE_KEY not set, skipping the paid flow."
	exit 1
fi

echo
echo "══ 5. Paid flow end to end (costs 2x the route price) ══"
echo
if ! SERVER_URL="$WORKER" npm run test:algo; then
	echo
	echo "Paid flow failed. Check the output above for which step."
	exit 1
fi

echo
echo "All checks passed."
