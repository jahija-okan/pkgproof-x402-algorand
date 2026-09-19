/**
 * End-to-end test for the Algorand rail: 8 steps, 2 of which settle payment
 * (costs 2x the route price — $0.10 on Mainnet). Run against a deployed
 * Worker, not `wrangler dev`.
 *
 *   ALGO_PRIVATE_KEY=<base64> SERVER_URL=https://... npx tsx test-algo.ts
 *
 * Testnet by default. For Mainnet:
 *
 *   ALGOD_URL=https://mainnet-api.algonode.cloud ASSET_ID=31566704 \
 *     ALGO_PRIVATE_KEY=<base64> SERVER_URL=https://... npx tsx test-algo.ts
 */

import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";

const SERVER_URL = process.env.SERVER_URL?.replace(/\/$/, "");
const ALGO_PRIVATE_KEY = process.env.ALGO_PRIVATE_KEY;

/** Which chain balances are read from. Defaults to Testnet; name both vars explicitly for Mainnet. */
const USDC_ASA = Number(process.env.ASSET_ID ?? 10458941);
const ALGOD = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";

const PACKAGE = { ecosystem: "npm", name: "left-pad", version: "1.3.0" };

if (!SERVER_URL || !ALGO_PRIVATE_KEY) {
	console.error("❌ SERVER_URL and ALGO_PRIVATE_KEY are both required");
	console.error("   ALGO_PRIVATE_KEY is base64, not a 25-word mnemonic.");
	process.exit(1);
}

const signer = toClientAvmSigner(ALGO_PRIVATE_KEY);

// Wildcard registration matches either CAIP-2 spelling of Algorand Mainnet.
const paymentClient = new x402HTTPClient(
	new x402Client().register("algorand:*", new ExactAvmScheme(signer))
);

/** Reads balances from algod, independent of anything the Worker reports. */
async function balances(address: string): Promise<{
	algo: bigint;
	usdc: bigint;
}> {
	const response = await fetch(`${ALGOD}/v2/accounts/${address}`);
	if (!response.ok) {
		console.error(`❌ algod ${response.status} for ${address}`);
		process.exit(1);
	}

	const account = (await response.json()) as {
		amount: number;
		assets?: { "asset-id": number; amount: number }[];
	};
	const holding = account.assets?.find((a) => a["asset-id"] === USDC_ASA);

	return {
		algo: BigInt(account.amount),
		usdc: BigInt(holding?.amount ?? 0),
	};
}

/** The 402's payment terms, as x402 v2 restores them to the response body. */
interface Terms {
	x402Version?: number;
	accepts?: {
		network?: string;
		asset?: string;
		payTo?: string;
		amount?: string;
		extra?: Record<string, unknown>;
	}[];
}

async function verify(
	headers: Record<string, string> = {},
	body: string = JSON.stringify(PACKAGE)
) {
	return fetch(`${SERVER_URL}/v1/verify`, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body,
	});
}

function settlementHeader(response: Response): string | null {
	return response.headers.get("x-payment-response");
}

/** Asks unpaid and returns the 402's terms. This rail has no free tier, so a 200 here means the paywall is open. */
async function quoteFor(label: string): Promise<{
	response: Response;
	terms: Terms;
}> {
	const response = await verify();

	if (response.status === 200) {
		console.error(
			`   ❌ ${label}: 200 to an unpaid call. This rail has no free tier, so the paywall is open.`
		);
		process.exit(1);
	}

	if (response.status !== 402) {
		console.error(`   ❌ ${label}: expected 402, got ${response.status}`);
		console.error(`      ${(await response.text()).slice(0, 300)}`);
		process.exit(1);
	}

	return { response, terms: (await response.clone().json()) as Terms };
}

/** Signs the quoted terms and returns the X-PAYMENT header. */
async function payFor(terms: Terms): Promise<Record<string, string>> {
	const payload = await paymentClient.createPaymentPayload(
		terms as unknown as Parameters<typeof paymentClient.createPaymentPayload>[0]
	);
	const headers = paymentClient.encodePaymentSignatureHeader(payload);

	if (Object.keys(headers).length === 0) {
		console.error("❌ signed the terms but got no payment header back");
		process.exit(1);
	}

	return headers;
}

async function main() {
	console.log("🧪 pkgproof x402, Algorand rail\n");
	console.log(`   Worker: ${SERVER_URL}`);
	console.log(`   Payer:  ${signer.address}\n`);

	const opening = await balances(signer.address);
	console.log(`   ALGO:   ${Number(opening.algo) / 1e6}`);
	console.log(`   USDC:   ${Number(opening.usdc) / 1e6}\n`);

	if (opening.usdc === 0n) {
		console.error(
			`❌ payer holds no USDC (ASA ${USDC_ASA}) on ${ALGOD}, so nothing can be paid.`
		);
		console.error(
			"   Opt in and fund it first, or check ALGOD_URL and ASSET_ID."
		);
		process.exit(1);
	}

	console.log("1. GET /up (unprotected, proxied to origin)");
	const health = await fetch(`${SERVER_URL}/up`);
	if (!health.ok) {
		console.error(`   ❌ expected 200, got ${health.status}`);
		console.error("      404 here means ORIGIN_SECRET is wrong or missing.");
		process.exit(1);
	}
	console.log("   ✅ 200: origin reachable and origin guard satisfied\n");

	console.log("2. POST /v1/verify without payment");
	const quote = await quoteFor("unpaid request");
	const accept = quote.terms.accepts?.[0];
	console.log(`   version:  ${quote.terms.x402Version}`);
	console.log(`   network:  ${accept?.network}`);
	console.log(`   asset:    ${accept?.asset}`);
	console.log(`   payTo:    ${accept?.payTo}`);
	console.log(`   amount:   ${accept?.amount}`);
	console.log(`   feePayer: ${accept?.extra?.feePayer ?? "MISSING"}`);
	console.log(`   tag:      ${accept?.extra?.tag ?? "MISSING"}`);

	if (accept?.extra?.tag !== "x402-global-challenge") {
		console.error("   ❌ challenge tag missing from extra");
		process.exit(1);
	}
	if (!accept?.extra?.feePayer) {
		console.error("   ❌ facilitator did not inject a feePayer");
		process.exit(1);
	}
	if (quote.terms.x402Version !== 2) {
		console.error(
			`   ❌ expected x402Version 2, got ${quote.terms.x402Version}`
		);
		process.exit(1);
	}
	console.log("   ✅ 402 with challenge attribution\n");

	console.log("3. POST /v1/verify, paid, with a body the origin rejects");
	const baseline = await balances(signer.address);
	const rejected = await verify(
		await payFor(quote.terms),
		JSON.stringify({ ecosystem: "npm", name: "" })
	);

	if (rejected.status !== 422) {
		console.error(`   ❌ expected 422 from the origin, got ${rejected.status}`);
		console.error(`      ${(await rejected.text()).slice(0, 300)}`);
		process.exit(1);
	}
	console.log("   ✅ 422: the origin's own rejection, passed through");

	if (settlementHeader(rejected)) {
		console.error("   ❌ settled anyway: the caller was billed for a failure");
		process.exit(1);
	}
	console.log("   ✅ no X-PAYMENT-RESPONSE: settlement was skipped\n");

	console.log("4. POST /v1/verify with signed payment");
	const paidHeader = await payFor(quote.terms);
	const paid = await verify(paidHeader);
	if (!paid.ok) {
		console.error(`   ❌ expected 200, got ${paid.status}`);
		console.error(`      ${(await paid.text()).slice(0, 400)}`);
		process.exit(1);
	}
	const verdict = (await paid.json()) as { verdict?: string };
	console.log(`   ✅ 200: verdict ${verdict.verdict}\n`);

	console.log("5. POST /v1/verify replaying the step-4 payment header");
	const replayed = await verify(paidHeader);
	const replayRaw = await replayed.text();

	if (settlementHeader(replayed)) {
		console.error("   ❌ settled a replay: the same payment charged twice");
		process.exit(1);
	}

	if (replayed.status === 409) {
		const spent = JSON.parse(replayRaw) as {
			error?: { code?: string };
			result?: unknown;
		};
		if (spent.error?.code !== "payment_already_used") {
			console.error(`   ❌ unexpected error code: ${spent.error?.code}`);
			process.exit(1);
		}
		console.log("   ✅ 409 payment_already_used: no second verification run");

		if (spent.result !== undefined) {
			console.error(
				"   ❌ the replay carried a verdict back: released against an unsettled payment"
			);
			process.exit(1);
		}
		console.log(
			"   ✅ carried no verdict: nothing released without settlement"
		);
	} else if (replayed.status === 402) {
		console.log("   ✅ 402: refused at verify, origin never contacted");
		console.log(`      facilitator said: ${replayRaw.slice(0, 160)}`);
	} else {
		console.error(`   ❌ unexpected replay status ${replayed.status}`);
		console.error(`      ${replayRaw.slice(0, 300)}`);
		process.exit(1);
	}
	console.log("   ✅ no X-PAYMENT-RESPONSE: nothing settled\n");

	console.log("6. POST /v1/verify again, unpaid (must NOT be free)");
	const secondQuote = await quoteFor("second unpaid request");
	console.log("   ✅ 402: access is metered per call\n");

	console.log("7. POST /v1/verify with a second signed payment");
	const paidAgain = await verify(await payFor(secondQuote.terms));
	if (!paidAgain.ok) {
		console.error(`   ❌ second payment rejected, status ${paidAgain.status}`);
		console.error(`      ${(await paidAgain.text()).slice(0, 400)}`);
		process.exit(1);
	}
	console.log("   ✅ 200: second payment accepted\n");

	console.log("8. On-chain accounting for the whole run");
	await new Promise((resolve) => setTimeout(resolve, 8000));
	const closing = await balances(signer.address);

	const spentMicro = baseline.usdc - closing.usdc;
	const price = BigInt(accept?.amount ?? "0");
	const expected = price * 2n;

	console.log(`   USDC spent: ${Number(spentMicro) / 1e6}`);
	console.log(`   ALGO spent: ${Number(baseline.algo - closing.algo) / 1e6}`);

	if (spentMicro !== expected) {
		console.error(
			`   ❌ expected exactly ${Number(expected) / 1e6} USDC across two settlements, saw ${Number(spentMicro) / 1e6}`
		);
		console.error(
			"      More means a rejected or replayed request settled. Less means a\n" +
				"      settlement is still pending, or a verdict was served unpaid."
		);
		process.exit(1);
	}
	console.log("   ✅ exactly two settlements, and nothing else moved\n");

	if (baseline.algo !== closing.algo) {
		console.error(
			`   ⚠️  the payer spent ALGO, so the facilitator did not sponsor the fee`
		);
	}

	console.log("🎉 Algorand rail verified end to end.");
	console.log("   402 → sign → settle → proxy → verdict, charged per call,");
	console.log("   and one authorisation buys exactly one verification.");
}

main().catch((error) => {
	console.error("❌", error);
	process.exit(1);
});
