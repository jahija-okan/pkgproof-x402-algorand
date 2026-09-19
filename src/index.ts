import { Buffer } from "node:buffer";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	decodePaymentRequiredHeader,
	decodePaymentSignatureHeader,
} from "@x402/core/http";
import {
	decodeSignedTransaction,
	decodeTransaction,
	getSenderFromTransaction,
	getTransactionId,
	isExactAvmPayload,
} from "@x402/avm";
import {
	createProtectedRoute,
	MAX_AUTHORIZATION_WINDOW_SECONDS,
	PAID_METHOD,
	type ProtectedRouteConfig,
} from "./auth";
import type { AppContext, Env } from "./env";

// @x402/avm's algokit-utils dependency reaches for a bare Buffer on the paid
// path; nodejs_compat does not put it on globalThis for bundled third-party code.
globalThis.Buffer ??= Buffer;

const app = new Hono<AppContext>();

/** Identifies who paid, which authorisation, and which invocation is spending it. */
interface PaymentIdentity {
	payer: string;
	nonce: string;
	requestId: string;
	/** Rounds the authorisation stays valid for (lastValid - firstValid), not a timestamp: Algorand bounds validity in rounds. */
	validityRounds: bigint;
}

/** Rough seconds per Algorand round, used to convert the advertised window into a round budget. Erring low is the safe direction. */
const ALGORAND_ROUND_SECONDS = 2.8;

/** Slack for client clock skew. */
const AUTHORIZATION_WINDOW_SLACK_SECONDS = 30;

/** x402 never checks that an authorisation's validity window matches what was advertised; this does. */
function authorizationOutlivesWindow(payment: PaymentIdentity): boolean {
	const budgetRounds = BigInt(
		Math.ceil(
			(MAX_AUTHORIZATION_WINDOW_SECONDS + AUTHORIZATION_WINDOW_SLACK_SECONDS) /
				ALGORAND_ROUND_SECONDS
		)
	);

	return payment.validityRounds > budgetRounds;
}

/**
 * Decodes payer, nonce and validity window out of the AVM payment payload.
 * Only called after x402's own verify() has accepted the payment, so a decode
 * failure here means the payload shape changed, not that the payment was bad.
 */
function paymentIdentity(
	header: string | undefined,
	requestId: string
): PaymentIdentity | null {
	if (!header) {
		return null;
	}

	try {
		const payload = decodePaymentSignatureHeader(header)?.payload;
		if (!isExactAvmPayload(payload)) {
			return null;
		}

		const encoded = payload.paymentGroup[payload.paymentIndex];
		if (typeof encoded !== "string") {
			return null;
		}

		const signedBytes = decodeTransaction(encoded);
		const { firstValid, lastValid } = decodeSignedTransaction(encoded).txn;

		// payer is the sender of the transfer, not of the group (the fee-payer
		// transaction beside it is signed by the facilitator). The transaction id
		// is the nonce: unique per transaction, and lookupable on chain afterwards.
		return {
			payer: getSenderFromTransaction(signedBytes, true),
			nonce: getTransactionId(signedBytes),
			requestId,
			validityRounds: BigInt(lastValid) - BigInt(firstValid),
		};
	} catch {
		return null;
	}
}

const BUILT_IN_PUBLIC_PATHS = ["/__x402/health", "/__x402/config"];

/**
 * Origin paths this Worker proxies without payment. Everything else is
 * refused before the origin is contacted. Exact matches only — no prefixes,
 * so adding a path here is a deliberate "serve this free, to anyone" decision.
 */
const FREE_PROXY_PATHS = [
	"/up",
	"/robots.txt",
	// Discovery documents, rendered per-rail via X-Pkgproof-Rail.
	"/openapi.json",
	"/.well-known/x402",
	"/.well-known/x402.json",
	"/llms.txt",
	"/favicon.ico",
	"/icon.svg",
	"/apple-touch-icon.png",
];

/**
 * Rewrites headers before proxying to the origin. Strips anything a client
 * could use to smuggle payment or auth state, then sets it fresh from what
 * this Worker itself verified — never merged from the inbound request.
 */
function originHeaders(
	request: Request,
	env: Env,
	authenticated: boolean,
	payment?: PaymentIdentity
): Headers {
	const headers = new Headers(request.headers);

	headers.delete("host");
	headers.delete("accept-encoding");

	headers.delete("X-Origin-Secret");
	if (authenticated && env.ORIGIN_SECRET) {
		headers.set("X-Origin-Secret", env.ORIGIN_SECRET);
	}

	headers.delete("X-Payment-Payer");
	headers.delete("X-Payment-Nonce");
	headers.delete("X-Payment-Request-Id");
	if (authenticated && payment) {
		headers.set("X-Payment-Payer", payment.payer);
		headers.set("X-Payment-Nonce", payment.nonce);
		headers.set("X-Payment-Request-Id", payment.requestId);
	}

	headers.delete("X-Free-Attempt");
	headers.delete("X-Free-Client-Ip");

	// Which rail's discovery documents to render. Set unconditionally: both
	// rails' terms are public, so there's nothing to gate this on.
	headers.delete("X-Pkgproof-Rail");
	headers.set("X-Pkgproof-Rail", "algorand");

	return headers;
}

/** Origin responses worth retrying. */
const RETRYABLE_ORIGIN_STATUSES = new Set([429, 500, 502, 503]);

/** First attempt, plus two retries. */
const ORIGIN_ATTEMPTS = 3;

/** No new attempt starts after this many ms, so retries can't outlive the payment authorisation's validity window. */
const RETRY_START_DEADLINE_MS = 25_000;

const RETRY_BACKOFF_MS = 200;

/**
 * The origin call for a paid request: transient failures are retried rather
 * than surfaced, since settlement only happens once the origin succeeds.
 */
async function proxyToOriginWithRetry(
	request: Request,
	env: Env,
	startedAt: number,
	payment: PaymentIdentity
): Promise<Response> {
	const method = request.method.toUpperCase();
	const body =
		method === "GET" || method === "HEAD" ? null : await request.arrayBuffer();

	let lastResponse: Response | undefined;
	let lastError: unknown;

	for (let attempt = 1; attempt <= ORIGIN_ATTEMPTS; attempt++) {
		try {
			lastResponse = await proxyToOrigin(
				new Request(request.url, { method, headers: request.headers, body }),
				env,
				true,
				payment
			);

			if (!RETRYABLE_ORIGIN_STATUSES.has(lastResponse.status)) {
				return lastResponse;
			}
			lastError = undefined;
		} catch (error) {
			lastResponse = undefined;
			lastError = error;
		}

		const outOfAttempts = attempt === ORIGIN_ATTEMPTS;
		const outOfTime = Date.now() - startedAt >= RETRY_START_DEADLINE_MS;

		if (outOfAttempts || outOfTime) {
			break;
		}

		console.warn(
			`[x402-proxy] origin attempt ${attempt}/${ORIGIN_ATTEMPTS} failed ` +
				`(${lastResponse ? `status ${lastResponse.status}` : String(lastError)}), retrying`
		);
		await new Promise((resolve) =>
			setTimeout(resolve, RETRY_BACKOFF_MS * attempt)
		);
	}

	if (lastResponse) {
		return lastResponse;
	}
	throw lastError;
}

/** Proxies to the origin: a bound service, an external URL, or DNS — in that priority. */
async function proxyToOrigin(
	request: Request,
	env: Env,
	authenticated: boolean,
	payment?: PaymentIdentity
): Promise<Response> {
	if (env.ORIGIN_SERVICE) {
		return env.ORIGIN_SERVICE.fetch(
			new Request(request, {
				headers: originHeaders(request, env, authenticated, payment),
			})
		);
	}

	if (env.ORIGIN_URL) {
		const originalUrl = new URL(request.url);
		const targetUrl = new URL(env.ORIGIN_URL);

		const proxiedUrl = new URL(request.url);
		proxiedUrl.hostname = targetUrl.hostname;
		proxiedUrl.protocol = targetUrl.protocol;
		proxiedUrl.port = targetUrl.port;

		const response = await fetch(proxiedUrl, {
			method: request.method,
			headers: originHeaders(request, env, authenticated, payment),
			body: request.body,
			redirect: "manual",
		});

		// Keep the caller on this hostname even if the origin redirects.
		const location = response.headers.get("Location");
		if (location) {
			try {
				const locationUrl = new URL(location, proxiedUrl);
				locationUrl.hostname = originalUrl.hostname;
				locationUrl.protocol = originalUrl.protocol;
				locationUrl.port = originalUrl.port;

				const newHeaders = new Headers(response.headers);
				newHeaders.set("Location", locationUrl.toString());

				return new Response(response.body, {
					status: response.status,
					statusText: response.statusText,
					headers: newHeaders,
				});
			} catch {
				// Unparseable Location: return the response as-is.
			}
		}

		return response;
	}

	return fetch(
		new Request(request, {
			headers: originHeaders(request, env, authenticated, payment),
		})
	);
}

/** Normalises a path the same way x402's own router does, so the two never disagree about what was requested. */
function canonicalPath(rawPath: string): string {
	return rawPath
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/(.+?)\/+$/, "$1");
}

/** RFC 3986's path character set. Anything else can crash x402's route-table lookup. */
const SAFE_PATH = /^[A-Za-z0-9._~\-/%:@!$&'()*+,;=]*$/;

function hasDotSegment(path: string): boolean {
	return path.split("/").some((segment) => segment === "." || segment === "..");
}

/** Rewrites the request onto its canonical path before it goes anywhere, so the origin sees what the payment decision was made about. */
function withCanonicalPath(request: Request, path: string): Request {
	const url = new URL(request.url);

	if (url.pathname === path) {
		return request;
	}

	url.pathname = path;
	return new Request(url, request);
}

/**
 * Exact match, or a `/*` prefix match. Case-insensitive, which is wider than
 * the origin's own routing — that can only widen what's read as protected,
 * never leak a verdict.
 */
function pathMatchesPattern(path: string, pattern: string): boolean {
	const foldedPath = path.toLowerCase();
	const foldedPattern = pattern.toLowerCase();

	if (foldedPattern.endsWith("/*")) {
		return foldedPath.startsWith(foldedPattern.slice(0, -2));
	}
	return foldedPath === foldedPattern;
}

function findProtectedRouteConfig(
	path: string,
	patterns: ProtectedRouteConfig[]
): ProtectedRouteConfig | null {
	return (
		patterns.find((config) => pathMatchesPattern(path, config.pattern)) ?? null
	);
}

/** Friendlier wording for x402's short error codes, so a caller knows whether they were charged. */
const PAYMENT_ERROR_MESSAGES: Record<string, string> = {
	"Payment required":
		"Payment required. Sign the payment requirements in `accepts` and resend with an X-PAYMENT header.",
	"No matching payment requirements":
		"Payment is invalid: it does not match the payment requirements for this route. Nothing has been charged.",
	"Invalid payment":
		"Payment is invalid: the X-PAYMENT header could not be decoded. Nothing has been charged.",
	"Settlement failed":
		"Payment could not be settled and you have NOT been charged. Sign a new payment and retry — an authorisation is valid for one request only.",
};

/** x402 v2 puts the payment terms in a PAYMENT-REQUIRED header; this restores them to the JSON body too. */
async function withPaymentTermsInBody(response: Response): Promise<Response> {
	const encoded = response.headers.get("PAYMENT-REQUIRED");
	if (response.status !== 402 || !encoded) {
		return response;
	}

	try {
		const terms = decodePaymentRequiredHeader(encoded);
		const error =
			typeof terms.error === "string"
				? (PAYMENT_ERROR_MESSAGES[terms.error] ?? terms.error)
				: terms.error;

		const body = JSON.stringify({ ...terms, error });
		const headers = new Headers(response.headers);
		headers.set("Content-Type", "application/json");
		headers.delete("Content-Length");

		return new Response(body, { status: response.status, headers });
	} catch {
		return response;
	}
}

/**
 * CORS, so a browser-based payer can complete the x402 flow.
 * `origin: "*"` is safe only because nothing here is credentialed: no cookies
 * are issued or read, and Allow-Credentials is never sent.
 */
app.use(
	"*",
	cors({
		origin: "*",
		allowMethods: ["POST", "GET", "HEAD", "OPTIONS"],
		allowHeaders: ["Content-Type", "X-PAYMENT", "Payment-Signature"],
		exposeHeaders: [
			"PAYMENT-REQUIRED",
			"PAYMENT-RESPONSE",
			"X-PAYMENT-RESPONSE",
		],
		maxAge: 86400,
	})
);

app.use("*", async (c, next) => {
	const notFound = () =>
		c.json({ error: { code: "not_found", message: "Not found." } }, 404);

	// Refuse percent-escapes before Hono's own decoding can make the raw path,
	// c.req.path and the origin's router disagree about what was requested.
	if (new URL(c.req.raw.url).pathname.includes("%")) {
		return notFound();
	}

	if (hasDotSegment(c.req.path) || !SAFE_PATH.test(c.req.path)) {
		return notFound();
	}

	const path = canonicalPath(c.req.path);
	const request = withCanonicalPath(c.req.raw, path);
	const protectedPatterns = c.env.PROTECTED_PATTERNS || [];

	// A path that only matches after case-folding is refused, not served —
	// charging for one spelling and proxying another would answer a request
	// nobody made.
	if (
		path !== path.toLowerCase() &&
		findProtectedRouteConfig(path, protectedPatterns)
	) {
		return notFound();
	}

	if (BUILT_IN_PUBLIC_PATHS.includes(path)) {
		return next();
	}

	const protectedConfig = findProtectedRouteConfig(path, protectedPatterns);
	if (protectedConfig) {
		if (c.req.method !== PAID_METHOD) {
			return c.json(
				{
					error: {
						code: "method_not_allowed",
						message: "Use POST for this endpoint.",
					},
				},
				405,
				{ Allow: PAID_METHOD }
			);
		}

		// Started before payment verification: the facilitator round trip comes
		// out of the same authorisation window that settlement has to fit inside.
		const startedAt = Date.now();
		const requestId = crypto.randomUUID();
		const protectedMiddleware = createProtectedRoute(protectedConfig, path);

		const result = await protectedMiddleware(c, async () => {
			const payment = paymentIdentity(
				c.req.header("X-PAYMENT") ?? c.req.header("Payment-Signature"),
				requestId
			);
			if (!payment) {
				c.res = c.json(
					{
						error: {
							code: "payment_unreadable",
							message:
								"The payment was accepted but could not be identified, so it cannot be spent safely. You have not been charged.",
						},
					},
					500
				);
				return;
			}

			if (authorizationOutlivesWindow(payment)) {
				c.res = c.json(
					{
						error: {
							code: "authorization_window_too_long",
							message:
								`This payment authorisation is signed to stay valid for longer than the ${MAX_AUTHORIZATION_WINDOW_SECONDS}s offered as ` +
								"`maxTimeoutSeconds`. Sign the advertised window and resend. You have not been charged.",
						},
					},
					402
				);
				return;
			}

			const originResponse = await proxyToOriginWithRetry(
				request,
				c.env,
				startedAt,
				payment
			);
			c.res = new Response(originResponse.body, originResponse);
		});

		if (result) {
			return await withPaymentTermsInBody(result);
		}
		return await withPaymentTermsInBody(c.res);
	}

	// The one path a human reaches by hand: send them to the shopfront.
	if (
		path === "/" &&
		(c.req.method === "GET" || c.req.method === "HEAD") &&
		c.env.ORIGIN_URL
	) {
		return c.redirect(new URL(c.env.ORIGIN_URL).origin + "/", 301);
	}

	if (
		!FREE_PROXY_PATHS.includes(path) ||
		!(c.req.method === "GET" || c.req.method === "HEAD")
	) {
		return notFound();
	}

	// Allowlisted paths are public on the origin too, so no secret is attached.
	return proxyToOrigin(request, c.env, false);
});

app.get("/__x402/health", (c) => {
	return c.json({
		status: "ok",
		proxy: "x402-proxy",
		message: "This endpoint is always public",
		timestamp: Date.now(),
	});
});

app.get("/__x402/config", (c) => {
	const patterns = (c.env.PROTECTED_PATTERNS || []) as ProtectedRouteConfig[];

	return c.json({
		network: c.env.NETWORK,
		payTo: c.env.PAY_TO ? `***${c.env.PAY_TO.slice(-6)}` : null,
		hasOriginUrl: !!c.env.ORIGIN_URL,
		hasOriginService: !!c.env.ORIGIN_SERVICE,
		protectedPatterns: patterns.map((p) => ({ pattern: p.pattern })),
	});
});

export default app;
