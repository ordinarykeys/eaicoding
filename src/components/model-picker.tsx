import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import {
  CaretDown,
  CaretRight,
  Check,
  Database,
  X,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import {
  useSettingsStore,
  type ProviderModel,
  type ProviderProfile,
} from "@/stores/settings";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import { deepSeekModelLabel } from "@/lib/deepseek-models";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const LEVEL_NAMES: Record<string, string> = {
  off: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};
function modelName(profile: ProviderProfile, model: ProviderModel) {
  return (
    model.name ||
    (profile.authMode !== "api-key" ? deepSeekModelLabel(model.id) : model.id)
  );
}
function Label({
  profile,
  model,
}: {
  profile: ProviderProfile;
  model: ProviderModel;
}) {
  const name = modelName(profile, model);
  const badge =
    (profile.authMode !== "api-key" ||
      (!profile.custom && profile.provider === "deepseek")) &&
    model.id === "deepseek-flash" &&
    name === "DeepSeek-V4.1-Flash";
  return (
    <span className="harness-model-label">
      <span>{name}</span>
      {badge && <span className="harness-model-badge">1017</span>}
    </span>
  );
}
/** Harness ModelSelect's two-level menu, grouped catalog, search threshold and effort mapping. */
export function ModelPicker({ disabled }: { disabled: boolean }) {
  const profiles = useSettingsStore((s) => s.profiles),
    activeId = useSettingsStore((s) => s.activeProfileId),
    select = useSettingsStore((s) => s.selectModel),
    update = useSettingsStore((s) => s.updateProfile);
  const signedIn = useDeepSeekAccount((s) => s.view.signedIn);
  const groups = useMemo(
    () =>
      profiles
        .filter((p) => p.authMode === "api-key" || signedIn)
        .map((profile) => ({ profile, models: profile.models ?? [] }))
        .filter((g) => g.models.length),
    [profiles, signedIn],
  );
  const profile = profiles.find((p) => p.id === activeId) ?? profiles[0],
    current = profile?.models?.find((m) => m.id === profile.model);
  const [open, setOpen] = useState(false),
    [pane, setPane] = useState<"root" | "model" | "effort">("root"),
    [query, setQuery] = useState(""),
    [saving, setSaving] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({
    visibility: "hidden",
    left: 0,
    top: 0,
  });
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    search = useRef<HTMLInputElement>(null);
  const menuId = useId();
  const total = groups.reduce((n, g) => n + g.models.length, 0),
    showSearch = total > 4;
  const filtered = useMemo(
    () =>
      groups
        .map((g) => ({
          ...g,
          models: g.models.filter(
            (m) =>
              !query ||
              (modelName(g.profile, m) + " " + m.id + " " + g.profile.name)
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
          ),
        }))
        .filter((g) => g.models.length),
    [groups, query],
  );
  const levels = current?.reasoning
    ? LEVELS.filter(
        (level) =>
          current.thinkingLevelMap?.[level] !== null &&
          (!["xhigh", "max"].includes(level) ||
            current.thinkingLevelMap?.[level] !== undefined),
      )
    : [];
  const effort = profile?.reasoningEffort ?? current?.defaultEffort;
  const effortChoices = current?.defaultEffort
    ? [...levels]
    : [undefined, ...levels];
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(),
        popup = menu.current;
      if (!anchor || !popup) return;
      setPosition((old) => {
        const left = Math.max(
            12,
            Math.min(
              anchor.right - popup.offsetWidth,
              innerWidth - popup.offsetWidth - 12,
            ),
          ),
          top = Math.max(
            12,
            Math.min(
              anchor.top - popup.offsetHeight - 8,
              innerHeight - popup.offsetHeight - 12,
            ),
          );
        return old.left === left &&
          old.top === top &&
          old.visibility !== "hidden"
          ? old
          : { left, top };
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, pane]);
  useEffect(() => {
    if (!open) return;
    if (pane === "model" && showSearch) search.current?.focus();
    else
      (
        menu.current?.querySelector('[aria-checked="true"]') ??
        menu.current?.querySelector("button")
      )?.scrollIntoView({ block: "nearest" });
    if (pane !== "model" || !showSearch)
      (
        menu.current?.querySelector<HTMLButtonElement>(
          '[aria-checked="true"]',
        ) ?? menu.current?.querySelector<HTMLButtonElement>("button")
      )?.focus();
  }, [open, pane, showSearch]);
  const choose = async (p: ProviderProfile, m: ProviderModel) => {
    setSaving(true);
    try {
      await select(p.id, m.id);
      close();
    } catch (e) {
      toast.error(`切换模型失败：${String(e)}`);
    } finally {
      setSaving(false);
    }
  };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (pane !== "root") {
        setPane("root");
        setQuery("");
      } else close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      close();
      return;
    }
    const items = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>(
        "button[data-select-item]:not(:disabled)",
      ) ?? [],
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      if (
        event.target === search.current &&
        ["Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1) % items.length
              : (index - 1 + items.length) % items.length;
      items[next]?.focus();
      items[next]?.scrollIntoView({ block: "nearest" });
    }
  };
  return (
    <div className="harness-model-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="harness-model-trigger"
        aria-label="选择模型"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={saving}
        disabled={disabled || saving}
        title={current ? modelName(profile, current) : "选择模型"}
        onClick={() => {
          setOpen((v) => !v);
          setPane("root");
          setQuery("");
        }}
      >
        <Database size={16} className="harness-model-small-icon" />
        <span className="harness-model-name">
          {current ? <Label profile={profile} model={current} /> : "选择模型"}
        </span>
        {levels.length > 0 && (
          <span className="harness-model-effort">
            {LEVEL_NAMES[effort ?? ""] ?? "提供商默认"}
          </span>
        )}
        <CaretDown size={12} />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            className="harness-model-menu"
            role={pane === "root" ? "menu" : "group"}
            aria-label="模型选择"
            style={position}
            onKeyDown={keyDown}
          >
            {pane === "root" ? (
              <>
                <button
                  data-select-item
                  type="button"
                  className="harness-model-cell"
                  role="menuitem"
                  onClick={() => setPane("model")}
                >
                  <span>模型</span>
                  <span className="harness-model-cell-value">
                    {current ? (
                      <Label profile={profile} model={current} />
                    ) : (
                      "选择模型"
                    )}
                  </span>
                  <CaretRight size={12} />
                </button>
                {levels.length > 0 && (
                  <button
                    data-select-item
                    type="button"
                    className="harness-model-cell"
                    role="menuitem"
                    onClick={() => setPane("effort")}
                  >
                    <span>推理强度</span>
                    <span className="harness-model-cell-value">
                      {LEVEL_NAMES[effort ?? ""] ?? "提供商默认"}
                    </span>
                    <CaretRight size={12} />
                  </button>
                )}
              </>
            ) : pane === "model" ? (
              <>
                {showSearch && (
                  <div className="harness-model-search">
                    <input
                      ref={search}
                      type="search"
                      role="searchbox"
                      aria-label="搜索模型"
                      placeholder="搜索模型"
                      value={query}
                      disabled={saving}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        aria-label="清空模型搜索"
                        onClick={() => {
                          setQuery("");
                          search.current?.focus();
                        }}
                      >
                        <X size={12} />
                      </button>
                    )}
                  </div>
                )}
                <div
                  className="harness-model-groups"
                  role="menu"
                  aria-label="模型"
                >
                  {filtered.map((g) => (
                    <div
                      role="group"
                      aria-label={
                        g.profile.authMode !== "api-key"
                          ? "DeepSeek 账号"
                          : g.profile.name
                      }
                      key={g.profile.id}
                    >
                      <div className="harness-model-group-label">
                        {g.profile.authMode !== "api-key"
                          ? "DeepSeek 账号"
                          : g.profile.name}
                      </div>
                      {g.models.map((m) => (
                        <button
                          data-select-item
                          type="button"
                          className="harness-model-option"
                          role="menuitemradio"
                          aria-checked={
                            profile?.id === g.profile.id &&
                            profile.model === m.id
                          }
                          key={m.id}
                          disabled={saving}
                          title={m.id}
                          onClick={() => void choose(g.profile, m)}
                        >
                          <Label profile={g.profile} model={m} />
                          <span className="harness-model-check">
                            {profile?.id === g.profile.id &&
                              profile.model === m.id && <Check size={14} />}
                          </span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
                {!filtered.length && (
                  <div className="harness-model-empty">
                    {total ? "没有匹配的模型" : "请先在设置中添加模型提供商"}
                  </div>
                )}
              </>
            ) : (
              <div
                className="harness-model-groups"
                role="menu"
                aria-label="推理强度"
              >
                {effortChoices.map((level) => (
                  <button
                    data-select-item
                    type="button"
                    role="menuitemradio"
                    className="harness-model-option"
                    key={level ?? "default"}
                    aria-checked={effort === level}
                    disabled={saving}
                    onClick={() => {
                      setSaving(true);
                      void update(profile.id, { reasoningEffort: level })
                        .then(close)
                        .catch((e) => toast.error(String(e)))
                        .finally(() => setSaving(false));
                    }}
                  >
                    <span>{level ? LEVEL_NAMES[level] : "提供商默认"}</span>
                    <span className="harness-model-check">
                      {effort === level && <Check size={14} />}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
