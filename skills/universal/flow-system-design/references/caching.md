# Caching

Read this when a change reads the same expensive or paid result repeatedly, adds a cache, or serves generated content to many readers.

## Decide first

- Cache only what is expensive to produce and read more often than it changes. Measure the hit rate you expect; a cache with a low hit rate is pure added staleness.
- For a paid generation (a model call), the durable result row is the cache: key it on the inputs that determine the output and read it before calling again. This also deduplicates concurrent identical requests.
- Never cache per-user or authorization-dependent responses in a shared cache without the user or tenant in the key.

## Patterns

- **Cache-aside:** read the cache, on a miss compute and store with a TTL. The default for application caches.
- **TTL plus explicit invalidation:** set a TTL as the safety net even when you also delete on write; a missed invalidation then heals itself.
- **Stale-while-revalidate:** serve the stale value and refresh in the background, so readers never wait on a recompute. HTTP form: https://www.rfc-editor.org/rfc/rfc5861
- **Stampede protection:** when a hot key expires, let one caller recompute (a lock or single-flight) and the rest serve stale or wait. Jitter TTLs so many keys do not expire together.
- **Negative caching:** cache "not found" briefly so a missing key cannot be hammered.

AWS Builders' Library on caching trade-offs, including cold-start and cache-down behaviour: https://aws.amazon.com/builders-library/caching-challenges-and-strategies/

## Layers

- **HTTP / CDN:** for public, cacheable GETs, set `Cache-Control` and let the CDN serve them. Semantics: https://www.rfc-editor.org/rfc/rfc9111
- **In-process memory:** per instance, lost on restart and not shared across instances; fine for small, read-mostly config, wrong for anything that must be consistent across instances.
- **Shared cache (Redis, Memorystore, KV):** shared across instances. Cloudflare KV is eventually consistent; writes can take 60 seconds or more to be visible in other locations: https://developers.cloudflare.com/kv/concepts/how-kv-works/

## Failure

The service must still work, more slowly, when the cache is empty or down. Load-test the cold path before relying on a cache to meet capacity.
