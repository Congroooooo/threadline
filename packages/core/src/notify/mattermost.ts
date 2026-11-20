import type { Notifier } from "./index.js";
import { postJson } from "./post.js";

export function mattermostNotifier(webhookUrl: string, fetchImpl: typeof fetch): Notifier {
  return { send: (m) => postJson(fetchImpl, webhookUrl, { text: m.link ? `${m.text}\n${m.link}` : m.text }) };
}
