# pkgproof x402 — Algorand rail

A Cloudflare Worker that puts an [x402](https://x402.org) payment gate in
front of [pkgproof](https://pkgproof.net), a pay-per-call npm supply-chain
verification API for AI agents. Settles USDC on **Algorand Mainnet** through
the [GoPlausible](https://facilitator.goplausible.xyz) facilitator, as an
entry in the
[Algorand Foundation Global x402 Challenge](https://algorand.co/global-x402-challenge).

**Live at:** `https://x402-algo.pkgproof.net`

## What this is

The payment layer only, not pkgproof's verification logic (the checks, the
heuristics, the data). That backend, `https://pkgproof.net`, is closed
source.

1. `POST /v1/verify` with no payment → `402` with signed terms: price,
   network, payment address, challenge attribution.
2. The agent signs a USDC transfer on Algorand and resends with an
   `X-PAYMENT` header.
3. This Worker verifies the payment with GoPlausible, decodes the payer and
   transaction ID, and refuses anything signed valid far longer than
   advertised (limits replay).
4. Only then does it forward to the pkgproof origin, retrying transient
   failures. Settlement happens only if the origin returns a verdict.
5. The agent gets its verdict plus a payment receipt.

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

## Running the checks

```bash
npm ci
npm run lint
npm run typecheck

# Free checks, then the paid flow if ALGO_PRIVATE_KEY is set:
ALGO_PRIVATE_KEY=<base64> ./verify-deploy.sh
```

## License

MIT — see [LICENSE](./LICENSE).
