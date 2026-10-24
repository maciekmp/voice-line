/** @param {unknown} value @returns {import('./application-contract.ts').WorkerResult | null} */
function parseWorkerResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = /** @type {Record<string, any>} */ (value);
  if (event.type !== 'command-result' || !Number.isSafeInteger(event.requestId) || event.requestId < 1) return null;
  const result = event.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.accepted === true && (result.operationId === null || (Number.isSafeInteger(result.operationId) && result.operationId > 0))) {
    return { type: 'command-result', requestId: event.requestId, result: { accepted: true, operationId: result.operationId } };
  }
  if (result.accepted === false && ['invalid', 'unavailable', 'busy', 'no-previous', 'disconnected', 'timeout'].includes(result.reason)) {
    return { type: 'command-result', requestId: event.requestId, result: { accepted: false, reason: result.reason } };
  }
  return null;
}
module.exports = { parseWorkerResult };
