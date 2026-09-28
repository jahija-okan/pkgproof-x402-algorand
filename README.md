# pkgproof x402

A Cloudflare Worker that puts an [x402](https://x402.org) payment gate in
front of [pkgproof](https://pkgproof.net), a pay-per-call npm supply-chain
verification API for AI agents. It settles USDC on Algorand Mainnet through
the [GoPlausible](https://facilitator.goplausible.xyz) facilitator, built for
the
[Algorand Foundation Global x402 Challenge](https://algorand.co/global-x402-challenge).

**Live at:** `https://x402-algo.pkgproof.net`

This is the payment rail, not the verification logic. pkgproof also settles
over Base through Coinbase's facilitator from a separate, private deploy with
a different hostname and no shared code. This repo is the Algorand side only.

## What this is

The payment layer only, not pkgproof's checks, heuristics, or data. The
backend this Worker proxies to, `https://pkgproof.net`, is closed source and
lives outside this repo. What's here: the paywall, discovery documents,
path/method hardening, retry policy, and the Algorand-specific plumbing that
turns a signed transaction into a decision to forward a request.

One route is sold: `POST /v1/verify`. Everything else is either public
(health check, favicon, discovery docs) or refused before the origin is ever
contacted.

## How x402 works here

x402 turns the "402 Payment Required" status code into a protocol: a server
prices a resource, a client signs a payment for exactly that price, and the
server settles it before doing the paid work. No accounts, no API keys, no
subscriptions, just a signed transaction attached to the request.

![Sequence diagram of the x402 payment flow: client requests a resource, gets a 402 with payment terms, signs a payment payload, resends the request with the payment attached, the server verifies and later settles it through a facilitator, then returns the result](./assets/x402-flow.png)

- **Client**: an AI agent (or `test-algo.ts`, or `verify-deploy.sh`)
- **Server**: this Worker
- **Facilitator**: GoPlausible, at `facilitator.goplausible.xyz`
- **Blockchain**: Algorand Mainnet

This Worker never touches an Algorand node directly, holds no private key,
and doesn't submit transactions itself. It hands a signed payload to
GoPlausible and asks it to verify, then later settle, the payment.
GoPlausible does the actual chain interaction, which keeps the Worker a
stateless edge function with no wallet infrastructure to run.

## Request lifecycle

1. An agent sends `POST /v1/verify` with no payment. The Worker returns
   `402` with signed terms in a `PAYMENT-REQUIRED` header (and mirrored in
   the JSON body): price, network, pay-to address, and a
   `maxTimeoutSeconds` window.
2. The agent builds a signed USDC transfer to that address on Algorand and
   resends the request with it in an `X-PAYMENT` header.
3. The Worker decodes the transaction itself (sender, transaction ID,
   validity window) and checks the signed window against what was
   advertised before spending a network round trip on anything else.
4. The facilitator verifies the payment is well-formed and spendable. Only
   then does the Worker forward the request to the pkgproof origin, with
   `X-Origin-Secret` and payer/nonce headers it sets itself.
5. On a transient origin failure (`429`, `500`, `502`, `503`), the Worker
   retries up to three times total, with no new attempt starting past 25
   seconds so retries can't outlive the payment's validity window.
6. Once the origin returns a verdict, the Worker settles the payment on
   chain. The agent gets the verdict and a payment receipt
   (`PAYMENT-RESPONSE`) in the same response.

If anything fails before settlement, nothing is charged, and the error
message says so.

## What this Worker enforces beyond x402 itself

x402 verifies that a payment is valid. It doesn't verify the payment matches
what was advertised for that route, and it doesn't care what else is
reachable behind the paywall. This Worker closes both gaps:

**Replay / authorization-window check.** Algorand transactions are valid
between a `firstValid` and `lastValid` round, not a wall-clock timestamp, so
a payment could stay spendable longer than the `maxTimeoutSeconds` the 402
advertised. The Worker converts that window (60s, plus 30s of clock-skew
slack) into a round budget at ~2.8s/round and rejects anything signed to
outlive it, with a `402` and no charge.

**Path hardening.** Percent-encoded paths, `.`/`..` segments, and anything
outside the RFC 3986 path character set are refused before Hono's router
sees them. Paths are matched case-insensitively for protection (so
`/V1/Verify` is still guarded), but a request only reaches the route on an
exact-case match; anything that only works after folding gets a 404.

**Method lock.** `/v1/verify` sells `POST` only. Every other method gets a
`405` with `Allow: POST`, before the payment table is even consulted.

**Origin secret, fails closed.** The origin refuses `/v1/*` without a
matching `X-Origin-Secret`. That header is stripped from every inbound
request and re-set by the Worker only after payment is confirmed, never
passed through from the client. A blank secret on the origin's side 404s
everyone, Worker included, instead of failing open.

**CORS without credentials.** `origin: "*"` is allowed so a browser-based
agent can complete the flow. That's safe because nothing here is
credentialed: no cookies are issued or read, and
`Access-Control-Allow-Credentials` is never sent.

**Explicit Mainnet safety checks.** Before serving a paid request, the
Worker confirms `PAY_TO` is a real Algorand address and, on Mainnet, that
`FACILITATOR_URL` points at `facilitator.goplausible.xyz`. A misconfigured
deploy fails with a 500 instead of quietly taking money nobody can
attribute.

## How an agent finds this route

- `/.well-known/x402` and `/.well-known/x402.json`: x402 discovery
- `/openapi.json`, `/llms.txt`: API description
- The `402` response carries a
  [Bazaar](https://github.com/coinbase/x402/tree/main/typescript/packages/x402-extensions/bazaar)
  discovery extension: input/output JSON Schema for `/v1/verify`, plus a
  merchant block (name, logo, categories) the facilitator reads

`verdict` is one of `safe`, `caution`, `block`, or `does_not_exist`, each
backed by `reasons` tagged `fact` or `heuristic`, so a caller can tell "this
is established" apart from "this is a signal."

## Pricing

| Route        | Method | Price | What it does                                                                                                                     |
| ------------ | ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------- |
| `/v1/verify` | `POST` | $0.05 | Verify one npm package before install: eight checks covering advisories, install scripts, typosquat names, repository provenance |

Price, path, and description all come from `wrangler.jsonc`'s
`PROTECTED_PATTERNS`, nothing route-specific is hardcoded in `src/`, so a
second paid route is config, not a code change.

## Structure

| Path               | What it is                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `src/index.ts`     | Routing, proxying, path/method hardening, retries                                              |
| `src/auth.ts`      | Payment terms, GoPlausible facilitator wiring, Bazaar discovery listing, Mainnet safety checks |
| `src/env.ts`       | Environment/binding types                                                                      |
| `wrangler.jsonc`   | Deploy config: hostname, price, wallet address, facilitator URL                                |
| `algo-account.ts`  | CLI: generate an Algorand key, opt into USDC, send ALGO, check a balance                       |
| `test-algo.ts`     | Paid end-to-end test against a live deployment (costs 2× the route price)                      |
| `verify-deploy.sh` | Post-deploy checks: paywall-bypass attempts, free-path allowlist, then the paid flow           |
| `assets/`          | The diagram above                                                                              |

## Local development

```bash
npm ci
cp .dev.vars.example .dev.vars   # fill in ORIGIN_SECRET
npm run dev
```

`wrangler dev` runs the Worker locally. `.dev.vars` holds secrets that
shouldn't live in `wrangler.jsonc` (currently just `ORIGIN_SECRET`); it's
gitignored, and `.dev.vars.example` shows the shape. No facilitator
credentials are needed, GoPlausible authenticates nothing and serves both
Algorand networks from one URL.

## Running the checks

```bash
npm ci
npm run lint
npm run typecheck

# Free checks, then the paid flow if ALGO_PRIVATE_KEY is set:
ALGO_PRIVATE_KEY=<base64> ./verify-deploy.sh
```

`verify-deploy.sh` runs against a live deployment (Testnet by default; point
`WORKER` at it, or override for Mainnet). It checks the paywall can't be
walked around before spending anything: unpaid calls, wrong methods, path
tricks, and a direct-to-origin bypass all have to fail correctly first. Only
then, if a key is set, does it run the paid flow through `test-algo.ts`,
which costs twice the route price since it triggers the 402 and completes a
real payment.

## The Algorand account helper

`algo-account.ts` is a small CLI for the account you'll need to run the paid
tests. It doesn't touch the Worker, just Algorand directly via `algosdk`:

```bash
npx tsx algo-account.ts new                              # generate a key, print it once
ALGO_PRIVATE_KEY=<base64> npx tsx algo-account.ts optin   # opt into USDC
ALGO_PRIVATE_KEY=<base64> npx tsx algo-account.ts send <to> <algo>
npx tsx algo-account.ts balance <address>
```

Testnet by default, against `algonode.cloud`. The private key is only ever
printed to your terminal, never written to disk, so what you do with it
after is on you. Mainnet USDC is asset `31566704`; the default `ASSET_ID` is
the Testnet one, so switching networks is a deliberate override
(`ALGOD_URL`/`ASSET_ID`), not a flag flip.

## Deploying

```bash
npm ci
npm run lint
wrangler deploy --minify
```

Needs a Cloudflare account with access to the `pkgproof.net` zone (the
Worker deploys onto a custom domain route under it) and `ORIGIN_SECRET`
already set as a Worker secret via `wrangler secret bulk`, not something this
repo can hand you, since it's the credential that proves a request to the
origin actually came through this paywall.

## License

MIT, see [LICENSE](./LICENSE).
