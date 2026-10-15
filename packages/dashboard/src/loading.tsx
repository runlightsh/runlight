import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n.js";

/** Content-shaped placeholders keep the layout steady while the first response arrives. */
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
          <div class="loading-bars">{[30, 46, 39, 61, 49, 72, 58, 84, 69, 91, 77, 96].map((height) => <span style={{ height: `${height}%` }} />)}</div>
        ) : (
          [72, 56, 83, 43, 63].map((width) => <div class="loading-row"><span style={{ width: `${width}%` }} /><span /></div>)
        )}
      </div>
    </div>
  );
}
