import { Avatar } from "./site-avatar.js";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { api, type Site, type Stats, type View } from "./api.js";
import { count, duration, percent } from "./format.js";
import { Sheet } from "./links.js";
import { t, type Key } from "./i18n.js";
import { Secret } from "./secret.js";
import { Icon } from "./icons.js";
import { Chevron, useFlyout } from "./picker.js";

/** The browser's own timezone, a good first guess for a new site's. */
function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Adds a site to an install whose sites are managed in the dashboard (the standalone server). */
export function AddSiteForm({ onAdded, onCancel }: { onAdded: (site: Site) => void; onCancel?: () => void }) {
  const [mode, setMode] = useState<"here" | "connect">("here");
  const [name, setName] = useState("");
  const [hostnames, setHostnames] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [token, setToken] = useState("");
  // Connecting goes through the other install's consent page; a pasted token is the fallback.
  const [withToken, setWithToken] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    if (mode === "connect" && !withToken) {
      api
        .connect(remoteUrl.trim())
        .then((r) => location.assign(r.authorize))
        .catch((err: Error) => {
          setError(err.message);
          setBusy(false);
        });
      return;
    }
    const input = mode === "here" ? { name: name.trim(), hostnames, timezone: localZone() } : { name: name.trim(), remote: { url: remoteUrl.trim(), token: token.trim() } };
    api
      .addSite(input)
      .then((r) => onAdded(r.site))
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };
  return (
    <form class="sheet-body link-form" onSubmit={submit}>
      <div class="ops add-mode" role="radiogroup" aria-label={t("sites.addTitle")}>
        {(["here", "connect"] as const).map((m) => (
          <button type="button" role="radio" aria-checked={mode === m} class={mode === m ? "op on" : "op"} onClick={() => setMode(m)}>
            {t(m === "here" ? "sites.modeHere" : "sites.modeConnect")}
          </button>
        ))}
      </div>
      {mode === "here" ? (
        <label class="field-row">
          <span class="field-label">{t("sites.domains")}</span>
          <input class="value" type="text" required autoFocus placeholder="example.com" value={hostnames} onInput={(e) => setHostnames((e.target as HTMLInputElement).value)} />
          <span class="field-hint">{t("sites.domainsHint")}</span>
        </label>
      ) : (
        <>
          <p class="settings-text">{t("sites.connectIntro")}</p>
          <label class="field-row">
            <span class="field-label">{t("sites.connectUrl")}</span>
            <input class="value" type="url" required placeholder="https://example.com/runlight" value={remoteUrl} onInput={(e) => setRemoteUrl((e.target as HTMLInputElement).value)} />
          </label>
          {withToken ? (
            <>
              <label class="field-row">
                <span class="field-label">{t("sites.connectToken")}</span>
                <Secret class="value" required autoComplete="off" placeholder="rl_..." value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
                <span class="field-hint">{t("sites.connectTokenHint")}</span>
              </label>
              <button type="button" class="text-button" onClick={() => setWithToken(false)}>
                {t("sites.useSignIn")}
              </button>
            </>
          ) : (
            <button type="button" class="text-button" onClick={() => setWithToken(true)}>
              {t("sites.useToken")}
            </button>
          )}
        </>
      )}
      {mode === "connect" && !withToken ? null : (
      <label class="field-row">
        <span class="field-label">{t("sites.name")}</span>
        <input class="value" type="text" maxLength={80} placeholder={t("sites.namePlaceholder")} value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
        {mode === "here" ? <span class="field-hint">{t("sites.timezoneHint", { zone: localZone().replace(/_/g, " ") })}</span> : null}
      </label>
      )}
      <div class="settings-actions">
        {error ? <span class="settings-error">{error}</span> : null}
        {onCancel ? (
          <button type="button" class="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </button>
        ) : null}
        <button type="submit" class="solid" disabled={busy || (mode === "here" ? !hostnames.trim() : !remoteUrl.trim() || (withToken && !token.trim()))}>
          <Icon name="plus" />
          {t(mode === "here" ? "sites.add" : "sites.connect")}
        </button>
      </div>
    </form>
  );
}

/** The whole page, for a standalone server with no sites yet. */
export function FirstSite({ onAdded }: { onAdded: (site: Site) => void }) {
  return (
    <main class="first-site">
      <div class="first-site-card">
        <h1>{t("sites.firstTitle")}</h1>
        <p class="settings-text">{t("sites.firstLead")}</p>
        <AddSiteForm onAdded={onAdded} />
      </div>
    </main>
  );
}

/** The site name as a menu: every site, then "Add a site" when sites are managed in the dashboard. */
export function SiteMenu({ sites, current, canAdd, onPick, onAdd, onAll }: { sites: Site[]; current: Site | undefined; canAdd: boolean; onPick: (id: string) => void; onAdd: () => void; onAll?: () => void }) {
  const { open, setOpen, root } = useFlyout();
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const searchable = sites.length > 7;
  const term = query.trim().toLocaleLowerCase();
  const filtered = searchable && term ? sites.filter((s) => [s.name, ...s.hostnames].some((value) => value.toLocaleLowerCase().includes(term))) : sites;
  useLayoutEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);
  return (
    <div class="site-menu" ref={root}>
      <button type="button" class="site-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => {
        if (!open) setQuery("");
        setOpen(!open);
      }}>
        <span class="site-button-name">{current?.name ?? "Runlight"}</span>
        <Chevron />
      </button>
      {open ? (
        <div class="site-flyout" role="dialog" aria-label={t("app.site")} onKeyDown={(e) => {
          if (e.key === "Escape") root.current?.querySelector<HTMLButtonElement>(".site-button")?.focus();
          const options = Array.from(root.current?.querySelectorAll<HTMLButtonElement>(".site-option") ?? []);
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            const stops: HTMLElement[] = search.current ? [search.current, ...options] : options;
            const index = stops.indexOf(e.target as HTMLElement);
            const next = e.key === "ArrowDown" ? (index + 1) % stops.length : (index < 0 ? stops.length - 1 : (index - 1 + stops.length) % stops.length);
            stops[next]?.focus();
          } else if (e.key === "Enter" && e.target === search.current) {
            e.preventDefault();
            options[0]?.focus();
          }
        }}>
          {searchable ? <div class="site-search"><input ref={search} type="search" class="value" aria-label={t("sites.search")} placeholder={t("sites.search")} value={query} onInput={(e) => setQuery(e.currentTarget.value)} /></div> : null}
          {filtered.length === 0 ? <p class="site-no-results" role="status">{t("empty.search", { q: query.trim() })}</p> : null}
          {filtered.map((s) => (
            <button
              type="button"
              aria-pressed={s.id === current?.id}
              class={s.id === current?.id ? "site-option on" : "site-option"}
              onClick={() => {
                setOpen(false);
                if (s.id !== current?.id) onPick(s.id);
              }}
            >
              <span class="site-option-text">
                <span class="site-option-name">{s.name}</span>
                {s.hostnames[0] && s.hostnames[0] !== s.name ? <span class="site-option-host">{s.hostnames[0]}</span> : null}
              </span>
              {s.id === current?.id ? <Icon name="check" /> : null}
            </button>
          ))}
          {onAll && sites.length > 1 ? (
            <>
              <hr />
              <button
                type="button"
                class="site-option site-add"
                onClick={() => {
                  setOpen(false);
                  onAll();
                }}
              >
                <Icon name="list" />
                <span>{t("sites.all")}</span>
              </button>
            </>
          ) : null}
          {canAdd ? (
            <>
              <hr />
              <button
                type="button"
                class="site-option site-add"
                onClick={() => {
                  setOpen(false);
                  onAdd();
                }}
              >
                <Icon name="plus" />
                <span>{t("sites.addTitle")}</span>
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Every site side by side for the chosen dates: the six numbers, and a click opens one. */
export function AllSites({ sites, view, onPick, onAdd, onClose }: { sites: Site[]; view: View; onPick: (id: string) => void; onAdd?: () => void; onClose: () => void }) {
  const [rows, setRows] = useState<Record<string, Stats | null>>({});
  type SortKey = "name" | "visitors" | "visits" | "pageviews" | "bounceRate" | "visitDuration";
  const [sort, setSort] = useState<SortKey>("visitors");
  const [ascending, setAscending] = useState(false);
  const columns: Array<[SortKey, Key]> = [["name", "sites.name"], ["visitors", "metric.visitors"], ["visits", "metric.visits"], ["pageviews", "metric.pageviews"], ["bounceRate", "metric.bounceRate"], ["visitDuration", "metric.visitDuration"]];
  const orderBy = (key: SortKey) => {
    setAscending(key === sort ? !ascending : key === "name");
    setSort(key);
  };
  useEffect(() => {
    for (const s of sites) {
      api
        .stats({ ...view, site: s.id, filters: [] })
        .then((r) => setRows((all) => ({ ...all, [s.id]: r.stats })))
        .catch(() => setRows((all) => ({ ...all, [s.id]: null })));
    }
  }, []);
  const sorted = [...sites].sort((a, b) => {
    if (sort === "name") return (ascending ? 1 : -1) * a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
    const av = rows[a.id]?.[sort], bv = rows[b.id]?.[sort];
    if (av === undefined || bv === undefined) return av === bv ? a.name.localeCompare(b.name) : av === undefined ? 1 : -1;
    return (ascending ? 1 : -1) * (av - bv) || a.name.localeCompare(b.name);
  });
  return (
    <Sheet title={t("sites.all")} wide onClose={onClose} action={onAdd ? (
      <button type="button" class="ghost sheet-add-site" onClick={onAdd}>
        <Icon name="plus" />
        {t("sites.addNew")}
      </button>
    ) : undefined}>
      <div class="sheet-body all-sites">
        <table class="all-table">
          <thead>
            <tr>
              {columns.map(([key, title]) => (
                <th aria-sort={sort === key ? ascending ? "ascending" : "descending" : "none"}>
                  <button type="button" class="sort-heading" onClick={() => orderBy(key)}>
                    {t(title)}
                    {sort === key ? <Icon name={ascending ? "arrow-up" : "arrow-down"} /> : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
              const r = rows[s.id];
              return (
                <tr>
                  <td>
                    <button type="button" class="name" onClick={() => onPick(s.id)}>
                      <Avatar site={s} />
                      <span class="name-text">{s.name}</span>
                    </button>
                  </td>
                  <td>{r ? count(r.visitors) : r === null ? "?" : "…"}</td>
                  <td>{r ? count(r.visits) : ""}</td>
                  <td>{r ? count(r.pageviews) : ""}</td>
                  <td>{r ? percent(r.bounceRate) : ""}</td>
                  <td>{r ? duration(r.visitDuration) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Sheet>
  );
}
