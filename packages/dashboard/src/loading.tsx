import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n.js";

/** Reserve space while the first response arrives, with a spinner for charts. */
export function Loading({ chart = false }: { chart?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return (
    <div class={chart ? "loading-skeleton loading-chart" : "loading-skeleton"} role="status">
      <span class="visually-hidden">{t("common.loading")}</span>
      <div aria-hidden="true" style={{ visibility: visible ? "visible" : "hidden" }}>
        {chart ? (
          <span class="chart-spinner" />
        ) : (
          [72, 56, 83, 43, 63].map((width) => <div class="loading-row"><span style={{ width: `${width}%` }} /><span /></div>)
        )}
      </div>
    </div>
  );
}

/** Settings lists show progress immediately so a pending list never looks empty. */
export function SettingsLoading() {
  return <div class="settings-loading" role="status"><span class="chart-spinner" aria-hidden="true" /><span>{t("common.loading")}</span></div>;
}
