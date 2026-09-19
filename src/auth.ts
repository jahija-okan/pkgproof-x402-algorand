import { Context, Next, MiddlewareHandler } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { FacilitatorConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { isValidAlgorandAddress } from "@x402/avm";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import type { AppContext, Env } from "./env";

/** Both CAIP-2 spellings of Algorand Mainnet: @x402/avm's canonical short form and the one GoPlausible actually advertises. */
const MAINNET_NETWORKS = [
	"algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
	"algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
];

/** The only facilitator the challenge leaderboard reads. */
const CHALLENGE_FACILITATOR_ORIGIN = "https://facilitator.goplausible.xyz";

/** How long a signed payment authorisation stays usable. Enforced in index.ts. */
export const MAX_AUTHORIZATION_WINDOW_SECONDS = 60;

function resolveFacilitator(env: Env): FacilitatorConfig | undefined {
	return env.FACILITATOR_URL ? { url: env.FACILITATOR_URL } : undefined;
}

/** Refuses to serve a paid route whose configuration cannot actually take money. */
function assertMainnetIsServable(env: Env, network: string): string | null {
	if (!env.PAY_TO || !isValidAlgorandAddress(env.PAY_TO)) {
		return (
			"Server misconfigured: PAY_TO is not a valid Algorand address, so a " +
			"payment could not be received. Nothing has been charged."
		);
	}

	if (!MAINNET_NETWORKS.includes(network)) {
		return null;
	}

	if (!env.FACILITATOR_URL) {
		return (
			"Server misconfigured: NETWORK is Algorand Mainnet but FACILITATOR_URL " +
			"is not set, so real payments cannot be settled. Nothing has been charged."
		);
	}

	if (!env.FACILITATOR_URL.startsWith(CHALLENGE_FACILITATOR_ORIGIN)) {
		return (
			"Server misconfigured: NETWORK is Algorand Mainnet but FACILITATOR_URL " +
			`is not ${CHALLENGE_FACILITATOR_ORIGIN}, so settled payments would not ` +
			"reach the challenge leaderboard. Nothing has been charged."
		);
	}

	return null;
}

export interface ProtectedRouteConfig {
	pattern: string;
	price: string;
	description: string;
}

/** Bazaar discovery extension: what an agent sends, and gets back. */
const DISCOVERY = declareDiscoveryExtension({
	bodyType: "json",
	input: { ecosystem: "npm", name: "left-pad", version: "1.3.0" },
	inputSchema: {
		type: "object",
		required: ["ecosystem", "name"],
		additionalProperties: false,
		properties: {
			ecosystem: {
				type: "string",
				enum: ["npm"],
				description: "npm is the only ecosystem this service verifies.",
			},
			name: {
				type: "string",
				description:
					"Package name. ASCII only; homoglyph and Unicode-confusable names are refused before any upstream call.",
			},
			version: {
				type: "string",
				description:
					"Optional. Omit to verify the package rather than one release.",
			},
		},
	},
	output: {
		example: {
			ecosystem: "npm",
			name: "left-pad",
			version: "1.3.0",
			verdict: "safe",
			reasons: [
				{
					verdict: "safe",
					code: "package_exists",
					kind: "fact",
					source: "npm registry",
					detail: "left-pad 1.3.0 is published on the npm registry.",
				},
				{
					verdict: "safe",
					code: "no_known_advisories",
					kind: "fact",
					source: "osv.dev",
					detail: "OSV lists no advisories for this version.",
				},
			],
			sources: {
				"npm registry": "https://registry.npmjs.org",
				"osv.dev": "https://api.osv.dev",
			},
			checked_at: "2026-08-26T12:00:00Z",
		},
		schema: {
			type: "object",
			required: [
				"ecosystem",
				"name",
				"verdict",
				"reasons",
				"sources",
				"checked_at",
			],
			properties: {
				ecosystem: { type: "string" },
				name: { type: "string" },
				version: { type: ["string", "null"] },
				verdict: {
					type: "string",
					enum: ["safe", "caution", "block", "does_not_exist"],
					description:
						"Ordered worst-last. The overall verdict is the worst any check produced. block and does_not_exist are answers, not errors, and return 200.",
				},
				reasons: {
					type: "array",
					description:
						"Evidence, one entry per finding. Branch on `code`, not on `detail`.",
					items: {
						type: "object",
						required: ["verdict", "code", "kind", "source", "detail"],
						properties: {
							verdict: { type: "string" },
							code: { type: "string" },
							kind: {
								type: "string",
								enum: ["fact", "heuristic"],
								description:
									"fact is established; heuristic is inference and never convicts on its own.",
							},
							source: { type: "string" },
							detail: { type: "string" },
							data: { type: "object" },
						},
					},
				},
				sources: {
					type: "object",
					description: "The upstream each check consulted, by name.",
				},
				checked_at: {
					type: "string",
					format: "date-time",
					description:
						"When the verification ran, which is not always when it was requested: a reused result carries its original timestamp.",
				},
			},
		},
	},
});

const SERVICE_NAME = "pkgproof";
const SERVICE_TAGS = [
	"npm",
	"security",
	"supply-chain",
	"package-verification",
	"typosquat",
	"malware",
];
const SERVICE_WEBSITE = "https://pkgproof.net";

/** Merchant identity read by the GoPlausible facilitator (not part of the x402 spec). */
const MERCHANT = {
	"x402-merchant": {
		info: {
			name: SERVICE_NAME,
			website: SERVICE_WEBSITE,
			logo: `${SERVICE_WEBSITE}/apple-touch-icon.png`,
			categories: SERVICE_TAGS,
		},
		schema: {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			required: ["name"],
			properties: {
				name: { type: "string" },
				website: { type: "string" },
				logo: { type: "string" },
				categories: { type: "array", items: { type: "string" } },
			},
		},
	},
};

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/** The resource URL a 402 advertises. Always https, except on loopback. */
function advertisedResourceUrl(requestUrl: string, routePath: string): string {
	const url = new URL(requestUrl);

	if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.includes(url.hostname)) {
		url.protocol = "https:";
	}

	return `${url.origin}${routePath}`;
}

/**
 * Payment middleware, built once per isolate rather than once per request:
 * x402 v2 won't price a route until it has confirmed the facilitator settles
 * `exact` on this network, so rebuilding per request would add that round
 * trip to every paid call.
 */
const MIDDLEWARE_CACHE = new Map<string, MiddlewareHandler>();

function cacheKey(
	routePath: string,
	resource: string,
	config: ProtectedRouteConfig,
	env: Env
): string {
	return JSON.stringify([
		routePath,
		resource,
		config.price,
		config.description,
		env.NETWORK,
		env.PAY_TO,
		env.FACILITATOR_URL,
	]);
}

function cachedPaymentMiddleware(
	key: string,
	build: () => MiddlewareHandler
): MiddlewareHandler {
	let middleware = MIDDLEWARE_CACHE.get(key);
	if (!middleware) {
		middleware = build();
		MIDDLEWARE_CACHE.set(key, middleware);
	}
	return middleware;
}

/** The one HTTP method sold at a paid route. index.ts refuses every other method before this table is consulted. */
export const PAID_METHOD = "POST";

export function createProtectedRoute(
	config: ProtectedRouteConfig,
	routePath: string
) {
	return async (c: Context<AppContext>, next: Next) => {
		const facilitator = resolveFacilitator(c.env);

		const network = c.env.NETWORK as Network;
		const misconfiguration = assertMainnetIsServable(c.env, network);
		if (misconfiguration) {
			return c.json({ error: misconfiguration }, 500);
		}

		const resource = advertisedResourceUrl(c.req.url, routePath);

		const routes = {
			[`${PAID_METHOD} ${routePath}`]: {
				resource,
				accepts: {
					scheme: "exact",
					payTo: c.env.PAY_TO,
					price: config.price,
					network,
					maxTimeoutSeconds: MAX_AUTHORIZATION_WINDOW_SECONDS,
					// feePayer is injected by the facilitator (ExactAvmScheme); not ours to set.
					extra: { tag: "x402-global-challenge" },
				},
				description: config.description,
				mimeType: "application/json",
				serviceName: SERVICE_NAME,
				tags: SERVICE_TAGS,
				extensions: { ...DISCOVERY, ...MERCHANT },
			},
		};

		const paymentMw = cachedPaymentMiddleware(
			cacheKey(routePath, resource, config, c.env),
			() => {
				const server = new x402ResourceServer(
					new HTTPFacilitatorClient(facilitator)
				).register(network, new ExactAvmScheme());
				return paymentMiddleware(routes, server);
			}
		);

		return await paymentMw(c, next);
	};
}
