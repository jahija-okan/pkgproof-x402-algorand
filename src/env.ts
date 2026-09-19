/**
 * Environment bindings. `CloudflareBindings` is generated from wrangler.jsonc
 * `vars`; secrets are declared here by hand since they're optional and never
 * appear in a generated file.
 */

export interface Env extends CloudflareBindings {
	/** Optional: a bound Worker to call directly instead of ORIGIN_URL. */
	ORIGIN_SERVICE?: Fetcher;

	/**
	 * Shared secret sent to the origin as X-Origin-Secret. Proves a request
	 * came through this Worker. Set with `wrangler secret bulk`, never as a var.
	 */
	ORIGIN_SECRET?: string;
}

export interface AppContext {
	Bindings: Env;
	Variables: Record<string, never>;
}
