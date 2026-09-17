import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ModelCatalog, ModelOption } from "../shared/types";
import { api } from "./api";

function price(value: number | null) {
  return value === null ? "Unknown" : `$${value.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function ModelPicker({ value, onChange }: { value: string; onChange: (model: string) => void }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("popular");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<ModelCatalog>(`/models${reload ? "?refresh=1" : ""}`, { signal: controller.signal })
      .then(setCatalog)
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load suggestions.");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reload]);

  const selected = catalog?.models.find((model) => model.id === value);
  const matches = useMemo(() => {
    const query = search.trim().toLowerCase();
    const models = (catalog?.models ?? []).filter((model) =>
      `${model.name} ${model.id}`.toLowerCase().includes(query),
    );
    if (sort === "price") models.sort((a, b) =>
      (a.outputUsdPerMillion ?? Infinity) - (b.outputUsdPerMillion ?? Infinity) ||
      (a.inputUsdPerMillion ?? Infinity) - (b.inputUsdPerMillion ?? Infinity),
    );
    return models;
  }, [catalog, search, sort]);
  const visible = matches.slice(0, 40);
  useEffect(() => { setActive(0); }, [search, sort, catalog]);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(model: ModelOption) {
    onChange(model.id);
    input.current?.focus();
    setSearch("");
    setOpen(false);
  }
  function show() { setOpen(true); setSearch(""); setActive(0); }

  return (
    <div className="field model-picker" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
    }}>
      <label className="model-label" htmlFor={id}>Model</label>
      {custom ? (
        <input id={id} autoFocus required value={value} onChange={(event) => onChange(event.target.value.trim())}
          placeholder="openrouter/author/model"
          pattern="(openrouter|anthropic|openai|google)/[^\s]+"
          title="Enter a full model ID beginning with openrouter/, anthropic/, openai/, or google/." />
      ) : (
        <div className="model-input">
          <input ref={input} id={id} role="combobox" aria-autocomplete="list" autoComplete="off"
            aria-expanded={open} aria-controls={`${id}-options`}
            aria-describedby={`${id}-help`}
            aria-activedescendant={open && visible[active] ? `${id}-option-${active}` : undefined}
            value={open ? search : selected?.name ?? value}
            placeholder="Search models on OpenRouter…"
            onFocus={show} onClick={() => { if (!open) show(); }}
            onChange={(event) => { setSearch(event.target.value); setOpen(true); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (!open) show();
                else setActive((index) => Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
              }
              if (event.key === "Enter" && open) {
                event.preventDefault();
                if (visible[active]) choose(visible[active]);
              }
            }} />
          <button type="button" className="model-toggle" aria-label={open ? "Close model suggestions" : "Show model suggestions"}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => { if (open) setOpen(false); else { input.current?.focus(); show(); } }}>⌄</button>
        </div>
      )}
      {!custom && open && (
        <div className="model-menu">
          <div className="model-menu-toolbar">
            <select aria-label="Sort model suggestions" value={sort} onChange={(event) => setSort(event.target.value)}>
              <option value="popular">Popular on OpenRouter</option>
              <option value="price">Lowest output price</option>
            </select>
            <button type="button" disabled={loading} onClick={() => setReload((n) => n + 1)}>{loading ? "Loading…" : "Refresh"}</button>
          </div>
          <p className="model-menu-note">Models with tool support. Popularity is weekly token usage, not a quality score.</p>
          {error && <p className="model-warning" role="status">{error}</p>}
          {catalog?.stale && <p className="model-warning" role="status">Refresh unavailable. Showing the catalog from {new Date(catalog.fetchedAt).toLocaleString()}.</p>}
          <ul ref={list} id={`${id}-options`} role="listbox" aria-label="OpenRouter models" aria-busy={loading}>
            {visible.map((model, index) => (
              <li key={model.id} id={`${id}-option-${index}`} role="option" aria-selected={value === model.id}
                className={active === index ? "active" : ""}
                onMouseDown={(event) => event.preventDefault()} onClick={() => choose(model)}>
                <div className="model-option-title"><strong>{model.name}</strong>{value === model.id && <span>Selected</span>}</div>
                <small className="model-id">{model.id.replace(/^openrouter\//, "")}</small>
                <small>{price(model.inputUsdPerMillion)} in · {price(model.outputUsdPerMillion)} out / 1M tokens · {new Intl.NumberFormat("en", { notation: "compact" }).format(model.contextLength)} context</small>
              </li>
            ))}
          </ul>
          {!loading && !error && !visible.length && <p className="model-menu-note" role="status">No matching models. Try another name or enter a model ID.</p>}
          <p className="model-menu-note">{matches.length > visible.length ? `Showing ${visible.length} of ${matches.length}. Search to narrow the list. ` : ""}Catalog prices vary by provider, context, and discounts.{catalog && !catalog.stale ? ` Updated ${new Date(catalog.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</p>
          <button type="button" className="model-manual" onClick={() => { setCustom(true); setOpen(false); }}>Enter model ID</button>
        </div>
      )}
      <div className="model-picker-footer">
        <small id={`${id}-help`}>{value || "Choose a model to continue."}</small>
        {(!open || custom) && <button type="button" onClick={() => { setCustom(!custom); setOpen(false); }}>{custom ? "Browse suggestions" : "Enter model ID"}</button>}
      </div>
    </div>
  );
}
