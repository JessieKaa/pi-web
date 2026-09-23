"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";

interface ScopeModel {
  provider: string;
  id: string;
  name: string;
  key: string;
}

interface ScopeResponse {
  models: ScopeModel[];
  readOnly: boolean;
  enabled: string[];
  error?: string;
}

function ScopeCheck({
  checked,
  indeterminate = false,
  disabled,
  label,
  detail,
  onChange,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled: boolean;
  label: string;
  detail?: string;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <label className="model-scope-row">
      <input ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={onChange} />
      <span>{label}</span>
      {detail ? <small>{detail}</small> : null}
    </label>
  );
}

export function ModelScopePanel({ cwd, onChanged }: { cwd: string | null; onChanged: () => void }) {
  const { t } = useI18n();
  const [models, setModels] = useState<ScopeModel[]>([]);
  const [enabled, setEnabled] = useState<Set<string>>(new Set());
  const [readOnly, setReadOnly] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
    const response = await fetch(`/api/models/scope${query}`);
    const data = await response.json() as ScopeResponse;
    if (!response.ok) throw new Error(data.error || "Failed to load models");
    setModels(data.models);
    setEnabled(new Set(data.enabled));
    setReadOnly(data.readOnly);
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    void load().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [load]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) => (
      model.provider.toLowerCase().includes(query)
      || model.name.toLowerCase().includes(query)
      || model.id.toLowerCase().includes(query)
    ));
  }, [filter, models]);

  const groups = useMemo(() => {
    const grouped = new Map<string, ScopeModel[]>();
    for (const model of visible) {
      const list = grouped.get(model.provider) ?? [];
      list.push(model);
      grouped.set(model.provider, list);
    }
    return [...grouped];
  }, [visible]);

  const toggle = useCallback(async (provider: string, ids: string[] | undefined, next: boolean) => {
    if (readOnly || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/models/scope", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(cwd ? { cwd } : {}),
          provider,
          ...(ids ? { ids } : {}),
          enabled: next,
        }),
      });
      const data = await response.json() as ScopeResponse;
      if (!response.ok) {
        setError(data.error === "keep-one" ? t("settings.modelScopeKeepOne") : (data.error || "Failed to update models"));
        return;
      }
      setModels(data.models);
      setEnabled(new Set(data.enabled));
      setReadOnly(data.readOnly);
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [busy, cwd, onChanged, readOnly, t]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const response = await fetch("/api/models/scope", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cwd ? { cwd } : {}),
      });
      const data = await response.json() as { error?: string; errors?: { provider: string; message: string }[] };
      if (!response.ok) throw new Error(data.error || "Failed to refresh models");
      if (data.errors && data.errors.length > 0) {
        setError(data.errors.map((entry) => `${entry.provider}: ${entry.message}`).join("\n"));
      }
      await load();
      onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRefreshing(false);
    }
  }, [cwd, load, onChanged]);

  return (
    <section className="model-scope" aria-label={t("settings.modelScope")}>
      <div className="model-scope-heading">
        <div>
          <strong>{t("settings.modelScope")}</strong>
          <span>{readOnly ? t("settings.modelScopeReadOnly") : t("settings.modelScopeDescription")}</span>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw size={14} aria-hidden="true" />
          {refreshing ? t("settings.modelScopeRefreshing") : t("settings.modelScopeRefresh")}
        </button>
      </div>
      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("settings.modelScopeFilter")}
        aria-label={t("settings.modelScopeFilter")}
      />
      {error && <div className="settings-inline-error" role="alert">{error}</div>}
      <div className="model-scope-list">
        {groups.length === 0 ? <p>{t("settings.modelScopeEmpty")}</p> : groups.map(([provider, providerModels]) => {
          const enabledCount = providerModels.filter((model) => enabled.has(model.key)).length;
          const allOn = enabledCount === providerModels.length && providerModels.length > 0;
          return (
            <div key={provider} className="model-scope-provider">
              <ScopeCheck
                checked={allOn}
                indeterminate={enabledCount > 0 && !allOn}
                disabled={readOnly || busy}
                label={provider}
                detail={`${enabledCount}/${providerModels.length}`}
                onChange={() => void toggle(
                  provider,
                  filter.trim() ? providerModels.map((model) => model.id) : undefined,
                  !allOn,
                )}
              />
              {providerModels.map((model) => (
                <ScopeCheck
                  key={model.key}
                  checked={enabled.has(model.key)}
                  disabled={readOnly || busy}
                  label={model.name}
                  detail={model.id === model.name ? undefined : model.id}
                  onChange={() => void toggle(provider, [model.id], !enabled.has(model.key))}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
