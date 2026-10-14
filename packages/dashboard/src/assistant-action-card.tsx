import type { ChatAction } from "./assistant-action.js";
import { t, type Key } from "./i18n.js";
import { Icon } from "./icons.js";

export function ActionCard({ action, site, allowed, disabled, onConfirm, onCancel }: { action: ChatAction; site: string; allowed: boolean; disabled: boolean; onConfirm: () => void; onCancel: () => void }) {
  const d = action.draft;
  const fields: Array<[string, string]> = [[t("app.site"), site]];
  if ("name" in d.input) fields.push([t("goals.name"), d.input.name]);
  if (d.action === "goal") {
    fields.push([t("goals.counts"), t(`goals.kind.${d.input.kind}` as Key)], [t(d.input.kind === "event" ? "goals.match.event" : d.input.kind === "page" ? "goals.match.page" : d.input.clickBy === "link" ? "goals.match.link" : "goals.match.selector"), d.input.match]);
    fields.push([t("goals.valueLabel"), d.input.valueMode === "none" ? t("goals.value.none") : d.input.valueMode === "fixed" ? `${d.input.value} ${d.input.currency}` : `${d.input.valueProp} (${d.input.currency})`]);
  }
  if (d.action === "funnel") d.input.steps.forEach((s, i) => fields.push([`${i + 1}. ${t(s.kind === "page" ? "goals.kind.page" : "goals.kind.event")}`, s.match]));
  if (d.action === "invite" || d.action === "report") fields.push([t("assistant.action.email"), d.input.email]);
  if (d.action === "invite") fields.push([t("people.role"), t(`people.${d.input.role}` as Key)]);
  if (d.action === "report") fields.push([t("reports.frequency"), t(d.input.frequency === "weekly" ? "reports.weekly" : "reports.monthly")], [t("reports.language"), d.input.lang]);
  return (
    <section class="assistant-action" aria-label={t(`assistant.action.${d.action}` as Key)}>
      <h3>{t(`assistant.action.${d.action}` as Key)}</h3>
      <dl>{fields.map(([label, value]) => <div><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {d.action === "share" ? <p>{t("assistant.action.shareHint")}</p> : d.action === "invite" ? <p>{t("assistant.action.inviteHint")}</p> : d.action === "report" ? <p>{t("assistant.action.reportHint")}</p> : null}
      {action.status === "pending" ? (
        <>
          <p>{t(allowed ? "assistant.action.review" : "assistant.action.denied")}</p>
          <div class="settings-actions start">
            <button type="button" class="solid" disabled={!allowed || disabled} onClick={onConfirm}><Icon name="check" />{t(`assistant.action.${d.action}` as Key)}</button>
            <button type="button" class="ghost" disabled={disabled} onClick={onCancel}>{t("common.cancel")}</button>
          </div>
        </>
      ) : <p role="status">{action.result || t(`assistant.action.${action.status}` as Key)}</p>}
      {action.link ? <a href={action.link} target="_blank" rel="noopener noreferrer">{t("assistant.action.openLink")}</a> : null}
    </section>
  );
}
