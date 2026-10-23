const PRIVATE_API_CACHES = ['api-user', 'api-pads'] as const;

/** Remove cached authenticated API responses after the session has ended. */
export async function clearPrivateApiCaches(
  storage?: Pick<CacheStorage, 'delete'>,
): Promise<void> {
  const target = storage ?? (typeof caches === 'undefined' ? undefined : caches);
  if (!target) return;
  await Promise.all(PRIVATE_API_CACHES.map(name => target.delete(name)));
}
