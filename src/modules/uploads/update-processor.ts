export function shouldIgnoreDuplicateUpdate(updateId: number, seenIds: Set<number>): boolean {
  if (seenIds.has(updateId)) {
    return true
  }
  seenIds.add(updateId)
  return false
}
