/**
 * Algorand account helper: generate a key, opt into USDC, send ALGO, check a balance.
 *
 *   npx tsx algo-account.ts new
 *   ALGO_PRIVATE_KEY=<base64> npx tsx algo-account.ts optin
 *   ALGO_PRIVATE_KEY=<base64> npx tsx algo-account.ts send <to> <algo>
 *   npx tsx algo-account.ts balance <address>
 *
 * Testnet by default. Mainnet USDC is asset 31566704 — switch to it deliberately.
 */

import algosdk from "algosdk";

const ALGOD = process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud";
const ASSET_ID = Number(process.env.ASSET_ID ?? 10458941);

const client = new algosdk.Algodv2("", ALGOD, "");

/** Prints a new key pair. Never writes it to disk — copy what you need into a password manager. */
function generate() {
	const account = algosdk.generateAccount();

	console.log(`ADDRESS  = ${account.addr}`);
	console.log(`KEY_B64  = ${Buffer.from(account.sk).toString("base64")}`);
	console.log(`MNEMONIC = ${algosdk.secretKeyToMnemonic(account.sk)}`);
	console.log(
		`\nFund it, then opt into asset ${ASSET_ID} before sending it anything.`
	);
}

/** Opts an account into an asset (a zero-amount self-transfer). Requires ALGO for the fee and the raised minimum balance. */
async function optIn(privateKeyBase64: string) {
	const sk = new Uint8Array(Buffer.from(privateKeyBase64, "base64"));
	const address = algosdk.encodeAddress(sk.slice(32));

	console.log(`Opting ${address} into asset ${ASSET_ID}`);

	const suggestedParams = await client.getTransactionParams().do();
	const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
		sender: address,
		receiver: address,
		amount: 0,
		assetIndex: ASSET_ID,
		suggestedParams,
	});

	const { txid } = await client.sendRawTransaction(txn.signTxn(sk)).do();
	await algosdk.waitForConfirmation(client, txid, 4);

	console.log(`✅ opted in, txid ${txid}`);
}

/** Sends plain ALGO, leaving the sender's own minimum balance and one fee untouched. */
async function send(privateKeyBase64: string, to: string, whole: string) {
	const sk = new Uint8Array(Buffer.from(privateKeyBase64, "base64"));
	const from = algosdk.encodeAddress(sk.slice(32));
	const amount = BigInt(Math.round(Number(whole) * 1e6));

	const account = await client.accountInformation(from).do();
	const spare = BigInt(account.amount) - BigInt(account.minBalance) - 1000n;

	if (amount > spare) {
		console.error(
			`❌ ${from} can spare ${Number(spare) / 1e6} ALGO, not ${whole}.`
		);
		console.error(
			"   Its minimum balance and one transaction fee are held back."
		);
		process.exit(1);
	}

	const suggestedParams = await client.getTransactionParams().do();
	const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
		sender: from,
		receiver: to,
		amount,
		suggestedParams,
	});

	const { txid } = await client.sendRawTransaction(txn.signTxn(sk)).do();
	await algosdk.waitForConfirmation(client, txid, 4);

	console.log(`✅ sent ${whole} ALGO to ${to}, txid ${txid}`);
}

async function balance(address: string) {
	const account = await client.accountInformation(address).do();
	const holding = account.assets?.find((a) => Number(a.assetId) === ASSET_ID);

	console.log(`ALGO         = ${Number(account.amount) / 1e6}`);
	console.log(
		`ASSET ${ASSET_ID} = ${
			holding ? Number(holding.amount) / 1e6 : "NOT OPTED IN"
		}`
	);

	if (!holding) {
		console.log("\nThis account cannot receive that asset until it opts in.");
	}
}

async function main() {
	const [command, argument] = process.argv.slice(2);

	switch (command) {
		case "new":
			return generate();
		case "optin": {
			const key = process.env.ALGO_PRIVATE_KEY;
			if (!key) {
				console.error("❌ ALGO_PRIVATE_KEY (base64) is required");
				process.exit(1);
			}
			return optIn(key);
		}
		case "send": {
			const key = process.env.ALGO_PRIVATE_KEY;
			const [, to, amount] = process.argv.slice(2);
			if (!key || !to || !amount) {
				console.error(
					"❌ ALGO_PRIVATE_KEY, a destination address and an amount are required"
				);
				process.exit(1);
			}
			return send(key, to, amount);
		}
		case "balance": {
			if (!argument) {
				console.error("❌ an address is required");
				process.exit(1);
			}
			return balance(argument);
		}
		default:
			console.error(
				"usage: algo-account.ts new | optin | send <to> <algo> | balance <address>"
			);
			process.exit(1);
	}
}

main().catch((error) => {
	console.error("❌", error);
	process.exit(1);
});
