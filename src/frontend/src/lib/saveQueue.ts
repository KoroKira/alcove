/** Keep writes from one editor instance in order so each write can use the
 * server version returned by the preceding write. */
export function enqueueSerializedSave(
  queue: { current: Promise<void> },
  save: () => Promise<void>,
): Promise<void> {
  const next = queue.current.then(save, save);
  queue.current = next.catch(() => {});
  return next;
}
