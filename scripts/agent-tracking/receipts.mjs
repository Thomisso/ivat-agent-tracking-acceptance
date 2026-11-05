// Owned commands are sent FIFO after saving the previous acknowledgment.
// Pin the latest outcome while bounding older terminal receipts. Passive
// retries re-read current facts rather than replaying an old phase snapshot.
export function compactReceipts(state) {
  const pinned = new Set(Object.entries(state.receipts).filter(([, receipt]) => !["published", "rejected"].includes(receipt.state)).map(([id]) => id));
  if (state.owner?.lastEventId) pinned.add(state.owner.lastEventId);
  else if (state.owner) {
    // Existing first-slice runs acquire a cursor with their next event.
    for (const [id, receipt] of Object.entries(state.receipts)) if (receipt.runId === state.owner.runId && receipt.generation === state.owner.generation && receipt.sequence === state.owner.sequence) pinned.add(id);
  } else if (state.generation > 0) pinned.add(state.runHistory[state.generation].eventId);
  const terminal = Object.entries(state.receipts).filter(([, receipt]) => ["published", "rejected"].includes(receipt.state) && !receipt.automaticDiscovery).map(([id]) => id);
  const keep = new Set([...pinned, ...terminal.slice(-32)]);
  for (const id of terminal) if (!keep.has(id)) delete state.receipts[id];
}
