/** Marks the usage of a request that never reached the provider (a cancelled
 *  or refused pace slot), so it is not counted as a billed step. */
const USAGE_KEY = Symbol.for("lh.subscription.unadmittedUsage");
const usageGlobal = globalThis as typeof globalThis & { [USAGE_KEY]?: WeakSet<object> };
const unadmittedUsage = usageGlobal[USAGE_KEY] ??= new WeakSet<object>();
/** Transient identity only: no new provenance field enters saved native messages. */
export function markUnadmittedUsage(usage: object): void { unadmittedUsage.add(usage); }
export function usageWasAdmitted(usage: object): boolean { return !unadmittedUsage.has(usage); }
