import { useEffect, useState } from "preact/hooks";
import { api, base, type ApiToken, type Site } from "./api.js";
import { day } from "./format.js";
import { Empty } from "./empty.js";
import { t } from "./i18n.js";
import { Icon } from "./icons.js";
import { DeleteButton } from "./links.js";
import { Code } from "./settings.js";

const dateOf = (ms: number) => day(new Date(ms).toISOString().slice(0, 10));

/**
 * Settings, MCP & API: tokens for scripts, apps, and AI assistants, and how to connect one. A token reads stats, or
 * reads them and changes one site's settings; the API makes a manage token only for one site.
 */
export function Tokens({ site: current, sites }: { site: Site; sites: Site[] }) {
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [name, setName] = useState("");
  const [site, setSite] = useState("");
  const [scope, setScope] = useState<"read" | "manage">("read");
  const [made, setMade] = useState<{ name: string; secret: string; scope: "read" | "manage" } | null>(null);
  const [error, setError] = useState("");
  const server = `${location.origin}${base}/mcp`;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  // A manage token is for one site, the one these settings are open on unless another is picked.
  const target = scope === "manage" ? site || current.id : site;

  const load = () =>
    api
      .tokens()
      .then((r) => setTokens(r.tokens))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const create = (e: Event) => {
    e.preventDefault();
    setError("");
    const label = name.trim();
    api
      .createToken(label, target, scope === "manage" ? "manage" : undefined)
      .then((r) => {
        setMade({ name: label, secret: r.secret, scope });
        setName("");
        return load();
      })
      .catch((err: Error) => setError(err.message));
  };

  const key = made?.secret ?? "YOUR_TOKEN";
  return (
    <div class="settings-group">
      <p class="settings-text">{t("tokens.intro")}</p>
      <p class="settings-text">
        <strong>{t("tokens.server")}</strong>
      </p>
      <Code>{server}</Code>

      {made ? (
        <div class="token-made">
          <p class="settings-text">
            <strong>{made.name}</strong>
            {" "}
            {t("tokens.once")}
          </p>
          <Code>{made.secret}</Code>
          {made.scope === "manage" ? (
            <p class="settings-text">{t("tokens.manageUse")}</p>
          ) : (
            <>
              <p class="settings-text">{t("tokens.claudeCode")}</p>
              <Code>{`claude mcp add --transport http runlight ${server} --header "Authorization: Bearer ${key}"`}</Code>
              <p class="settings-text">{t("tokens.json")}</p>
              <Code>{JSON.stringify({ mcpServers: { runlight: { url: server, headers: { Authorization: `Bearer ${key}` } } } }, null, 2)}</Code>
            </>
          )}
          <button type="button" class="ghost token-done" onClick={() => setMade(null)}>
            <Icon name="check" />
            {t("tokens.done")}
          </button>
        </div>
      ) : null}

      {tokens && tokens.length ? (
        <ul class="domain-list share-list">
          {tokens.map((token) => (
            <li key={token.id}>
              <div class="domain-main">
                <span class="share-name">{token.name}</span>
                <span class="share-meta">
                  {`rl_…${token.hint}`}
                  {" · "}
                  {token.site ? t("tokens.siteOnly", { site: siteName(token.site) }) : t("tokens.allSites")}
                  {token.scope === "manage" ? ` · ${t("tokens.manages")}` : token.scope === "embed" ? ` · ${t("tokens.embeds")}` : ""}
                  {" · "}
                  {t("links.createdOn", { date: dateOf(token.createdAt) })}
                  {" · "}
                  {token.lastUsedAt ? t("tokens.used", { date: dateOf(token.lastUsedAt) }) : t("tokens.never")}
                </span>
              </div>
              <div class="domain-actions">
                <DeleteButton
                  name={token.name}
                  onDelete={() => {
                    setError("");
                    void api
                      .deleteToken(token.id)
                      .then(load)
                      .catch((err: Error) => setError(err.message));
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      ) : tokens ? (
        <Empty size="card" icon="key" title={t("tokens.emptyTitle")} hint={t("tokens.empty")} />
      ) : null}
      <p class="field-hint domain-note">{t("tokens.revokeNote")}</p>
      <form class="domain-add token-add token-form" onSubmit={create}>
        <input class="value" type="text" maxLength={100} required placeholder={t("tokens.namePlaceholder")} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        <select class="value" value={scope} aria-label={t("tokens.can")} onChange={(e) => setScope((e.target as HTMLSelectElement).value as "read" | "manage")}>
          <option value="read">{t("tokens.read")}</option>
          <option value="manage">{t("tokens.manage")}</option>
        </select>
        {sites.length > 1 ? (
          <select class="value" value={target} aria-label={t("tokens.scope")} onChange={(e) => setSite((e.target as HTMLSelectElement).value)}>
            {scope === "manage" ? null : <option value="">{t("tokens.allSites")}</option>}
            {sites.map((s) => (
              <option value={s.id}>{t("tokens.siteOnly", { site: s.name })}</option>
            ))}
          </select>
        ) : null}
        <button type="submit" class="solid">
          <Icon name="key" />
          {t("tokens.create")}
        </button>
      </form>
      {scope === "manage" ? <p class="field-hint">{t("tokens.manageHint", { site: siteName(target) })}</p> : null}
      {error ? <span class="settings-error">{error}</span> : null}
    </div>
  );
}
