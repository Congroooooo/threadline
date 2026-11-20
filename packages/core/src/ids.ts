import { v7 } from "uuid";

let lastMsecs = -1;
let seq = 0;

/** UUID v7, lexically sortable by creation time, strictly increasing within one process. */
export function newId(): string {
  let msecs = Date.now();
  if (msecs <= lastMsecs) {
    // Same millisecond (or clock moved back): keep the timestamp and bump the counter.
    msecs = lastMsecs;
    seq += 1;
    if (seq > 0x3fffffff) {
      msecs += 1;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastMsecs = msecs;
  return v7({ msecs, seq });
}
