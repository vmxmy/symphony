const TRACKER_EVENTS_QUEUE = "symphony-tracker-events";
const DISPATCH_QUEUE = "symphony-dispatch";

function matchesQueueName(actual: string, canonical: string): boolean {
  return actual === canonical || actual.startsWith(`${canonical}-`);
}

export function isTrackerEventsQueue(queueName: string): boolean {
  return matchesQueueName(queueName, TRACKER_EVENTS_QUEUE);
}

export function isDispatchQueue(queueName: string): boolean {
  return matchesQueueName(queueName, DISPATCH_QUEUE);
}
