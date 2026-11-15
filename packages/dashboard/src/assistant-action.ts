import type { FunnelStep, GoalInput } from "./api.js";

export type ActionDraft =
  | { action: "goal"; input: GoalInput }
  | { action: "funnel"; input: { name: string; steps: FunnelStep[] } }
  | { action: "invite"; input: { email: string; role: "admin" | "member" | "viewer" } }
  | { action: "report"; input: { email: string; frequency: "weekly" | "monthly"; lang: string } }
  | { action: "share"; input: { name: string } };

/** Model output is untrusted. Only these fields can reach an existing creation API. */
export function actionDraft(raw: unknown): ActionDraft | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const text = (key: string, max: number) => typeof r[key] === "string" && r[key].trim().length <= max ? r[key].trim() : "";
  const name = text("name", 80);
  const email = text("email", 254);
  if (r.action === "share") return name ? { action: "share", input: { name } } : null;
  if (r.action === "invite") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (r.role === "member" || r.role === "viewer") ? { action: "invite", input: { email, role: r.role } } : null;
  if (r.action === "report") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && (r.frequency === "weekly" || r.frequency === "monthly") && ["en", "fr", "de", "es", "pt"].includes(String(r.lang)) ? { action: "report", input: { email, frequency: r.frequency, lang: String(r.lang) } } : null;
  if (r.action === "funnel") {
    if (!name || !Array.isArray(r.steps) || r.steps.length < 2 || r.steps.length > 8) return null;
    const steps: FunnelStep[] = [];
    for (const step of r.steps) {
      if (!step || (step.kind !== "page" && step.kind !== "event") || typeof step.match !== "string" || !step.match.trim() || step.match.length > 500) return null;
      steps.push({ kind: step.kind, match: step.match.trim() });
    }
    return { action: "funnel", input: { name, steps } };
  }
  if (r.action === "goal") {
    const match = text("match", 500);
    if (!name || !match || (r.kind !== "page" && r.kind !== "event" && r.kind !== "click")) return null;
    const valueMode = r.valueMode ?? "none";
    if (valueMode !== "none" && valueMode !== "fixed" && valueMode !== "prop") return null;
    if (r.kind === "click" && r.clickBy !== "selector" && r.clickBy !== "link") return null;
    const currency = text("currency", 3);
    if (valueMode !== "none" && !/^[A-Z]{3}$/.test(currency)) return null;
    if (valueMode === "fixed" && (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0 || r.value >= 1e9)) return null;
    const valueProp = text("valueProp", 40);
    if (valueMode === "prop" && (r.kind !== "event" || !/^[A-Za-z0-9_.-]{1,40}$/.test(valueProp))) return null;
    return { action: "goal", input: { name, kind: r.kind, match, clickBy: r.clickBy === "link" ? "link" : "selector", valueMode, value: valueMode === "fixed" ? Math.round(Number(r.value) * 100) / 100 : 0, valueProp: valueMode === "prop" ? valueProp : "", currency: currency || "USD" } };
  }
  return null;
}

export interface ChatAction {
  draft: ActionDraft;
  status: "pending" | "saving" | "done" | "cancelled" | "failed";
  result?: string;
  link?: string;
}

const CHATS = "runlight_assistant:";

/** Where a person's chat about a site is kept for the tab's session: by who is signed in, so nobody reads another's. */
export const chatKey = (who: string, site: string): string => `${CHATS}${who}:${site}`;

/**
 * The last of a chat as it is kept. A link an action made, such as an invite's, which lets whoever opens it
 * choose the account's password, shows once and is never kept.
 */
export function keptChat<M extends { action?: ChatAction }>(messages: M[]): string {
  return JSON.stringify(
    messages.slice(-40).map((m) => {
      if (!m.action?.link) return m;
      const { link: _link, ...action } = m.action;
      return { ...m, action };
    }),
  );
}

/** Forgets every chat this tab kept, when its person signs out or their session ends. */
export function forgetChats(storage: Pick<Storage, "length" | "key" | "removeItem"> | undefined = globalThis.sessionStorage): void {
  try {
    if (!storage) return;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(CHATS)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // No storage to clear.
  }
}
