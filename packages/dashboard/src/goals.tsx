import { Loading } from "./loading.js";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, base, type Funnel, type Goal, type GoalInput, type GoalReport, type GoalTotals, type Site, type View } from "./api.js";
import { Chart } from "./chart.js";
import { count, money, percent } from "./format.js";
import { currentLocale, t, type Key } from "./i18n.js";
import { Empty } from "./empty.js";
import { Icon } from "./icons.js";
import { Funnels, FunnelBars } from "./funnels.js";
import { DeleteButton, Sheet } from "./links.js";
import { label } from "./panel.js";
import { openInTab, openingIn } from "./open.js";

export const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "NZD", "JPY", "CHF", "SEK", "NOK", "DKK", "PLN", "BRL", "MXN", "INR", "SGD", "HKD", "ZAR"];

type Row = Goal & GoalTotals & { previous?: GoalTotals };

/** What a goal counts, in a few words. */
export function describeGoal(g: Goal): string {
  if (g.kind === "page") return t("goals.describe.page", { match: g.match });
  if (g.kind === "click") return t(g.clickBy === "link" ? "goals.describe.link" : "goals.describe.selector", { match: g.match });
  return t("goals.describe.event", { match: g.match });
}

function describeValue(g: Goal): string {
  if (g.valueMode === "fixed") return t("goals.value.each", { amount: money(g.value, g.currency) });
  if (g.valueMode === "prop") return t("goals.value.fromProp", { prop: g.valueProp, currency: g.currency });
  return "";
}

/** Revenue across goals, one figure per currency. */
function revenueText(rows: Row[]): string {
  const sums = new Map<string, number>();
  for (const r of rows) if (r.valueMode !== "none" && r.revenue) sums.set(r.currency, (sums.get(r.currency) ?? 0) + r.revenue);
  return [...sums].map(([c, n]) => money(n, c)).join(" + ");
}

/** The Conversions box: each goal's conversions, conversion rate, and revenue. */
export function ConversionsPanel({ view, readOnly, onAdd }: { view: View; readOnly?: boolean; onAdd: (section: "goals" | "funnels") => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  // A linked goal opens once the report shows it is one, so a mistyped id opens nothing.
  const [wanted, setWanted] = useState(() => openingIn("goal") ?? "");
  const [funnels, setFunnels] = useState<Funnel[]>([]);
  const [showing, setShowing] = useState<"goals" | "funnels">("goals");
  useEffect(() => {
    let live = true;
    setError("");
    api
      .goals(view)
      .then((r) => {
        if (!live) return;
        setRows(r.goals);
        if (wanted) {
          if (r.goals.some((g) => g.id === wanted)) setOpen(wanted);
          setWanted("");
        }
      })
      .catch((e: Error) => live && setError(e.message));
    api
      .funnels(view)
      .then((r) => live && setFunnels(r.funnels))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [view]);
  if (readOnly && rows && rows.length === 0 && funnels.length === 0) return null;
  if (showing === "funnels" && funnels.length) {
    return (
      <section class={readOnly ? "panel full" : "panel"}>
        <header class="panel-head">
          <h2>{t("panel.conversions")}</h2>
          <div class="head-tools">
            <nav class="tabs" aria-label={t("panel.conversions")}>
              <button type="button" class="tab" aria-pressed={false} onClick={() => setShowing("goals")}>
                {t("funnels.goalsTab")}
              </button>
              <button type="button" class="tab on" aria-pressed={true}>
                {t("funnels.tab")}
              </button>
            </nav>
            {readOnly ? null : (
              <button type="button" class="box-button icon-only" title={t(showing === "funnels" ? "funnels.add" : "goals.add")} aria-label={t(showing === "funnels" ? "funnels.add" : "goals.add")} onClick={() => onAdd(showing)}>
                <Icon name="plus" />
              </button>
            )}
          </div>
        </header>
        {funnels.map((f) => (
          <div class="funnel-block">
            <h3 class="funnel-name">{f.name}</h3>
            <FunnelBars funnel={f} />
          </div>
        ))}
      </section>
    );
  }
  const top = Math.max(1, ...(rows ?? []).map((r) => r.conversions));
  const revenue = rows ? revenueText(rows) : "";
  const sorted = [...(rows ?? [])].sort((a, b) => b.conversions - a.conversions || a.name.localeCompare(b.name));
  return (
    // Alone on a shared dashboard (no links box), so it takes the whole row.
    <section class={readOnly ? "panel full" : "panel"}>
      <header class="panel-head">
        <h2>
          {t("panel.conversions")} {revenue ? <span class="aside">{t("goals.revenueAside", { amount: revenue })}</span> : null}
        </h2>
        {/* The Goals and Funnels switch sits with the add button, as Links keeps its tabs beside its buttons. */}
        <div class="head-tools">
          {funnels.length ? (
            <nav class="tabs" aria-label={t("panel.conversions")}>
              <button type="button" class="tab on" aria-pressed={true}>
                {t("funnels.goalsTab")}
              </button>
              <button type="button" class="tab" aria-pressed={false} onClick={() => setShowing("funnels")}>
                {t("funnels.tab")}
              </button>
            </nav>
          ) : null}
          {!readOnly && !funnels.length ? <button type="button" class="box-button" onClick={() => onAdd("funnels")}><Icon name="plus" />{t("funnels.add")}</button> : null}
          {readOnly ? null : (
            // With the switch beside it, the button keeps only its icon so the header stays on one line.
            <button type="button" class={funnels.length ? "box-button icon-only" : "box-button"} title={t(showing === "funnels" ? "funnels.add" : "goals.add")} aria-label={t(showing === "funnels" ? "funnels.add" : "goals.add")} onClick={() => onAdd(showing)}>
              <Icon name="plus" />
              {funnels.length ? null : t("goals.add")}
            </button>
          )}
        </div>
      </header>
      {error ? <p class="empty">{error}</p> : null}
      {!rows && !error ? <Loading /> : null}
      {rows && rows.length === 0 ? <Empty icon="target" title={t("goals.emptyTitle")} hint={t("goals.emptyHint")} /> : null}
      {rows && rows.length ? (
        <>
          <div class="table">
          <div class="cols">
            <span>{t("goals.goal")}</span>
            <span class="extra">{t("goals.rate")}</span>
            <span class="num-head">{t("goals.conversions")}</span>
          </div>
          <ol class="rows">
            {sorted.map((r) => (
              <li>
                <span class="bar" style={{ width: `${(r.conversions / top) * 100}%` }} />
                <button type="button" class="name" title={describeGoal(r)} onClick={() => openInTab(`goal:${r.id}`) || setOpen(r.id)}>
                  <span class="name-text">{r.name}</span>
                  {r.valueMode !== "none" && r.revenue ? <span class="goal-money">{money(r.revenue, r.currency)}</span> : null}
                </button>
                <span class="extra">{percent(r.rate)}</span>
                <span class="num">{count(r.conversions)}</span>
              </li>
            ))}
          </ol>
          </div>
        </>
      ) : null}
      {open ? <GoalDetail view={view} id={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function GoalList({ title, rows, dimension, currency, valued }: { title: Key; rows: GoalReport["pages"]; dimension: string; currency: string; valued: boolean }) {
  const top = Math.max(1, ...rows.map((r) => r.conversions));
  return (
    <section class="mini">
      <h3>{t(title)}</h3>
      {rows.length === 0 ? <Empty size="line" icon="chart" title={t("empty.mini")} /> : null}
      <ol class="rows">
        {rows.map((r) => (
          <li>
            <span class="bar" style={{ width: `${(r.conversions / top) * 100}%` }} />
            <span class="name">
              <span class="name-text">{label(dimension, r.value) || t("goals.unknown")}</span>
            </span>
            {valued ? <span class="extra">{money(r.revenue, currency)}</span> : null}
            <span class="num">{count(r.conversions)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** One goal over the dashboard's range: totals, a chart, and where conversions came from. */
function GoalDetail({ view, id, onClose }: { view: View; id: string; onClose: () => void }) {
  const [report, setReport] = useState<GoalReport | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.goal(view, id).then(setReport).catch((e: Error) => setError(e.message));
  }, [view, id]);
  const g = report?.goal;
  const valued = Boolean(g && g.valueMode !== "none");
  const series = g
    ? [
        { key: "conversions", slot: 1, label: t("goals.conversions"), format: count },
        ...(valued ? [{ key: "revenue", slot: 4, label: t("goals.revenue"), format: (n: number) => money(n, g.currency) }] : []),
      ]
    : [];
  return (
    <Sheet title={g?.name ?? t("common.loading")} sub={g ? describeGoal(g) : undefined} wide onClose={onClose}>
      <div class="sheet-body">
        {error ? <p class="failure">{error}</p> : null}
        {report && g ? (
          <>
            <div class="goal-tiles">
              <div>
                <span>{t("goals.conversions")}</span>
                <strong>{count(report.totals.conversions)}</strong>
              </div>
              <div>
                <span>{t("goals.converted")}</span>
                <strong>{count(report.totals.visitors)}</strong>
              </div>
              <div>
                <span>{t("goals.rate")}</span>
                <strong>{percent(report.totals.rate)}</strong>
              </div>
              {valued ? (
                <div>
                  <span>{t("goals.revenue")}</span>
                  <strong>{money(report.totals.revenue, g.currency)}</strong>
                </div>
              ) : null}
            </div>
            <h3 class="mini-title">{t(valued ? "goals.overTimeValued" : "goals.overTime")}</h3>
            <div class="link-chart">
              <Chart
                points={report.series as unknown as Array<{ start: number } & Record<string, number>>}
                metrics={series}
                interval={report.range.interval}
                timezone={report.range.timezone}
                height={240}
              />
            </div>
            <div class="mini-grid three">
              <GoalList title="goals.byChannel" rows={report.channels} dimension="channel" currency={g.currency} valued={valued} />
              <GoalList title="goals.bySource" rows={report.sources} dimension="source" currency={g.currency} valued={valued} />
              <GoalList title="goals.byPage" rows={report.pages} dimension="page" currency={g.currency} valued={valued} />
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}

const blank: GoalInput = { name: "", kind: "event", match: "", clickBy: "selector", valueMode: "none", value: 0, valueProp: "revenue", currency: "USD" };

function Segmented<T extends string>({ value, options, onChange, label: aria }: { value: T; options: Array<[T, Key]>; onChange: (v: T) => void; label: string }) {
  return (
    <div class="ops" role="radiogroup" aria-label={aria}>
      {options.map(([v, k]) => (
        <button type="button" role="radio" aria-checked={value === v} class={value === v ? "op on" : "op"} onClick={() => onChange(v)}>
          {t(k)}
        </button>
      ))}
    </div>
  );
}

/** Add or edit a goal. */
function GoalForm({ site, goal, view, onDone }: { site: Site; goal: Goal | null; view: View; onDone: () => void }) {
  const [input, setInput] = useState<GoalInput>(() => (goal ? { ...goal } : { ...blank, currency: localCurrency() }));
  const [amount, setAmount] = useState(goal?.valueMode === "fixed" ? String(goal.value) : "");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const pickNonce = useRef("");
  const set = (patch: Partial<GoalInput>) => setInput((i) => ({ ...i, ...patch }));

  // Names already seen, so an event goal is a pick rather than a guess.
  useEffect(() => {
    if (input.kind === "click") return setSuggest([]);
    api
      .breakdown({ ...view, period: "90d", from: "", to: "", filters: [] }, input.kind === "event" ? "event" : "page", 50)
      .then((r) => setSuggest(r.rows.map((x) => x.value).filter(Boolean)))
      .catch(() => setSuggest([]));
  }, [input.kind]);

  // The choice comes back from the relay page on this origin, which the picker's tab goes to; only the pick
  // this tab started, by its nonce, counts.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("runlight-pick");
    channel.onmessage = (e: MessageEvent) => {
      const data = e.data as { runlight?: string; nonce?: string; selector?: string; text?: string };
      if (data?.runlight !== "pick" || !pickNonce.current || data.nonce !== pickNonce.current || typeof data.selector !== "string") return;
      pickNonce.current = "";
      setPicking(false);
      set({ match: data.selector.slice(0, 500), clickBy: "selector", ...(input.name ? {} : { name: String(data.text || "").slice(0, 60) }) });
    };
    return () => channel.close();
  }, [input.name]);

  const host = site.hostnames[0];
  const pick = () => {
    if (!host) return;
    setError("");
    setPicking(true);
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    pickNonce.current = nonce;
    try {
      localStorage.setItem("runlight-pick", nonce);
    } catch {}
    // The tab opens at once, while the click still allows it, and goes to the site when the ticket is back. It
    // is cut off from this one first, so nothing on the site can reach or move the dashboard.
    const opened = window.open("about:blank", "_blank");
    if (!opened) {
      pickNonce.current = "";
      setPicking(false);
      setError(t("goals.pickBlocked"));
      return;
    }
    opened.opener = null;
    // The ticket names this dashboard's relay page and the nonce, so the picker sends its choice here and nowhere else.
    api
      .pickTicket(site.id, location.origin, `${location.origin}${base}/pick-return`, nonce)
      .then(({ ticket }) => {
        // A ticket with no return address is from an older install, whose picker can only answer the tab that
        // opened it, and this one leaves it none.
        if (ticket.split(".").length < 6) throw new Error(t("goals.pickUpdate"));
        if (opened) opened.location.href = `https://${host}/?runlight=pick&runlight_lang=${currentLocale().slice(0, 2)}&runlight_ticket=${encodeURIComponent(ticket)}`;
      })
      .catch((err: Error) => {
        opened?.close();
        pickNonce.current = "";
        setPicking(false);
        setError(err.message);
      });
  };

  const save = (e: Event) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    const values = { ...input, value: input.valueMode === "fixed" ? Number(amount) : input.value };
    (goal ? api.updateGoal(site.id, goal.id, values) : api.createGoal(site.id, values))
      .then(onDone)
      .catch((err: Error) => setError(err.message))
      .finally(() => setSaving(false));
  };

  const listId = "goal-suggestions";
  return (
    <form class="goal-form" onSubmit={save}>
      <label class="field-row">
        <span class="field-label">{t("goals.name")}</span>
        <input class="value" type="text" maxLength={80} value={input.name} placeholder={t("goals.namePlaceholder")} onInput={(e) => set({ name: (e.target as HTMLInputElement).value })} />
      </label>
      <div class="field-row">
        <span class="field-label">{t("goals.counts")}</span>
        <Segmented
          label={t("goals.counts")}
          value={input.kind}
          options={[
            ["event", "goals.kind.event"],
            ["page", "goals.kind.page"],
            ["click", "goals.kind.click"],
          ]}
          onChange={(kind) => set({ kind, match: "", ...(kind !== "event" && input.valueMode === "prop" ? { valueMode: "fixed" as const } : {}) })}
        />
      </div>
      {input.kind === "click" ? (
        <div class="field-row">
          <span class="field-label">{t("goals.clickOn")}</span>
          <Segmented
            label={t("goals.clickOn")}
            value={input.clickBy === "link" ? "link" : "selector"}
            options={[
              ["selector", "goals.click.selector"],
              ["link", "goals.click.link"],
            ]}
            onChange={(clickBy) => set({ clickBy, match: "" })}
          />
        </div>
      ) : null}
      <label class="field-row">
        <span class="field-label">{t(input.kind === "event" ? "goals.match.event" : input.kind === "page" ? "goals.match.page" : input.clickBy === "link" ? "goals.match.link" : "goals.match.selector")}</span>
        <div class="match-row">
          <input
            class="value"
            type="text"
            spellcheck={false}
            list={suggest.length ? listId : undefined}
            value={input.match}
            placeholder={input.kind === "event" ? "Signup" : input.kind === "page" ? "/thanks*" : input.clickBy === "link" ? "https://buy.stripe.com/*" : "#signup, .buy-button"}
            onInput={(e) => set({ match: (e.target as HTMLInputElement).value })}
          />
          {input.kind === "click" && input.clickBy !== "link" && host ? (
            <button type="button" class="ghost" onClick={pick}>
              <Icon name="target" />
              {t(picking ? "goals.picking" : "goals.pick")}
            </button>
          ) : null}
        </div>
        <datalist id={listId}>
          {suggest.map((v) => (
            <option value={v} />
          ))}
        </datalist>
        <span class="field-hint">
          {t(input.kind === "event" ? "goals.hint.event" : input.kind === "page" ? "goals.hint.page" : input.clickBy === "link" ? "goals.hint.link" : "goals.hint.selector")}
        </span>
        {picking ? <span class="field-hint" role="status">{t("goals.pickWaiting")}</span> : null}
      </label>
      <div class="field-row">
        <span class="field-label">{t("goals.valueLabel")}</span>
        <Segmented
          label={t("goals.valueLabel")}
          value={input.valueMode}
          options={[
            ["none", "goals.value.none"],
            ["fixed", "goals.value.fixed"],
            ...(input.kind === "event" ? ([["prop", "goals.value.prop"]] as Array<["prop", Key]>) : []),
          ]}
          onChange={(valueMode) => set({ valueMode })}
        />
        {input.valueMode !== "none" ? <span class="field-hint">{t(input.valueMode === "fixed" ? "goals.value.fixedHint" : "goals.value.propHint")}</span> : null}
      </div>
      {input.valueMode !== "none" ? (
        <div class="value-row">
          {input.valueMode === "fixed" ? (
            <label class="field-row">
              <span class="field-label">{t("goals.amount")}</span>
              <input class="value" type="number" inputmode="decimal" min="0" max="999999999.99" step="0.01" required placeholder="49.99" value={amount} onInput={(e) => setAmount((e.target as HTMLInputElement).value)} />
            </label>
          ) : (
            <label class="field-row">
              <span class="field-label">{t("goals.property")}</span>
              <input class="value" type="text" spellcheck={false} maxLength={40} value={input.valueProp} onInput={(e) => set({ valueProp: (e.target as HTMLInputElement).value })} />
            </label>
          )}
          <label class="field-row">
            <span class="field-label">{t("goals.currency")}</span>
            <select class="value" value={input.currency} onChange={(e) => set({ currency: (e.target as HTMLSelectElement).value })}>
              {CURRENCIES.map((c) => (
                <option value={c}>{c}</option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {input.valueMode === "prop" ? (
        <div class="code small">
          <pre>
            <code>{`runlight(${JSON.stringify(input.match || "Purchase")}, { ${JSON.stringify(input.valueProp || "revenue")}: 49.99 })`}</code>
          </pre>
        </div>
      ) : null}
      {error ? <p class="settings-error">{error}</p> : null}
      <div class="settings-actions start">
        <button type="submit" class="solid" disabled={saving}>
          <Icon name="check" />
          {t(goal ? "goals.save" : "goals.create")}
        </button>
        <button type="button" class="ghost" onClick={onDone}>
          {t("goals.cancel")}
        </button>
      </div>
    </form>
  );
}

function localCurrency(): string {
  const region = (navigator.language.split("-")[1] ?? "").toUpperCase();
  const byRegion: Record<string, string> = { GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", JP: "JPY", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", BR: "BRL", MX: "MXN", IN: "INR", SG: "SGD", HK: "HKD", ZA: "ZAR" };
  const euro = new Set(["DE", "FR", "ES", "IT", "NL", "BE", "AT", "PT", "IE", "FI", "GR", "LU", "SK", "SI", "EE", "LV", "LT", "MT", "CY", "HR"]);
  return byRegion[region] ?? (euro.has(region) ? "EUR" : "USD");
}

/** Settings, Goals: what counts as a conversion, and what each one is worth. */
export function Goals({ site, view }: { site: Site; view: View }) {
  const [goals, setGoals] = useState<Goal[] | null>(null);
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api
      .goals({ ...view, site: site.id })
      .then((r) => setGoals(r.goals))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [site.id]);
  const sorted = useMemo(() => goals ?? [], [goals]);

  if (editing) {
    return (
      <div class="settings-group">
        <GoalForm
          site={site}
          view={view}
          goal={editing === "new" ? null : editing}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      </div>
    );
  }
  return (
    <div class="settings-group">
      <p class="settings-text">{t("goals.intro")}</p>
      {sorted.length ? (
        <ul class="domain-list goal-list">
          {sorted.map((g) => (
            <li>
              <div class="domain-main">
                <span class="share-name">{g.name}</span>
                <span class="share-meta">
                  {describeGoal(g)}
                  {describeValue(g) ? ` · ${describeValue(g)}` : ""}
                </span>
              </div>
              <div class="domain-actions">
                <button type="button" class="copy inline" onClick={() => setEditing(g)}>
                  <Icon name="edit" />
                  {t("goals.edit")}
                </button>
                <DeleteButton name={g.name} onDelete={() => void api.deleteGoal(site.id, g.id).then(load)} />
              </div>
            </li>
          ))}
        </ul>
      ) : goals ? (
        <Empty size="card" icon="target" title={t("goals.emptyTitle")} hint={t("goals.none")} />
      ) : null}
      {error ? <p class="settings-error">{error}</p> : null}
      <p class="field-hint domain-note">{t("goals.pastNote")}</p>
      <div class="settings-actions start">
        <button type="button" class="solid" onClick={() => setEditing("new")}>
          <Icon name="plus" />
          {t("goals.add")}
        </button>
      </div>
    </div>
  );
}
