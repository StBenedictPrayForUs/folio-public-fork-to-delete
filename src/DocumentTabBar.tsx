import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { copyText } from "./clipboard";
import type { ReaderContext } from "./documentTabs";
import { Icon } from "./icons";
import { keys } from "./platform";

export function DocumentTabBar({ tabs, tabKey }: { tabs: ReaderContext["tabs"]; tabKey: number }) {
  useSyncExternalStore(tabs.subscribe, tabs.snapshot);
  const selected = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ key: number; x: number; y: number } | null>(null);
  useLayoutEffect(() => {
    if (tabs.active === tabKey) {
      selected.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (tabs.keyboardFocus === tabKey) selected.current?.focus({ preventScroll: true });
    }
  }, [tabs.active, tabs.keyboardFocus, tabKey]);
  return <nav className="document-tabs" aria-label="Documents">
    <div className="document-tab-list" role="tablist" aria-label="Open documents">
      {tabs.all.map(tab => {
        const active = tab.key === tabKey;
        const name = tab.name || "Library";
        return <div key={tab.key} className={active ? "document-tab selected" : "document-tab"}
          onContextMenu={event => { event.preventDefault(); setMenu({ key: tab.key, x: event.clientX, y: event.clientY }); }}>
          <button type="button" role="tab" aria-selected={active} aria-controls={active ? "reader-panel" : undefined}
            id={active ? "selected-document-tab" : undefined} tabIndex={active ? 0 : -1}
            ref={active ? selected : undefined} title={name} aria-label={name} onClick={event => tabs.select(tab.key, event.detail === 0)}
            onKeyDown={event => {
              if (event.altKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              if (event.key === "Home" || event.key === "End") tabs.select(tabs.all[event.key === "Home" ? 0 : tabs.all.length - 1].key, true);
              else tabs.cycle(event.key === "ArrowRight" ? 1 : -1);
            }}>
            <Icon name={tab.name ? "file" : "book"} size={14} /><span>{name}</span>
          </button>
          <button className="close-document-tab" title={tab.dirty ? "Unsaved changes · Close tab" : "Close tab"}
            aria-label={`Close ${name}${tab.dirty ? ", unsaved changes" : ""}`} onClick={() => void tabs.close(tab.key)}>
            {tab.dirty && <span className="dirty-dot" aria-hidden="true" />}<Icon name="close" size={13} />
          </button>
        </div>;
      })}
    </div>
    <button className="new-document-tab icon-btn" title={keys("New tab (Ctrl+T)")} aria-label="New tab" onClick={() => tabs.library()}>
      <Icon name="plus" size={16} />
    </button>
    {menu && <TabMenu {...menu} path={tabs.pathOf(menu.key)} onClose={() => setMenu(null)} />}
  </nav>;
}

/** A tab's right-click menu. */
function TabMenu({ x, y, path, onClose }: { x: number; y: number; path?: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.style.left = Math.max(4, Math.min(x, window.innerWidth - el.offsetWidth - 4)) + "px";
    el.style.top = Math.max(4, Math.min(y, window.innerHeight - el.offsetHeight - 4)) + "px";
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);
  return createPortal(
    <div ref={ref} className="menu page-export-menu tab-menu" role="menu" aria-label="Tab actions">
      <button role="menuitem" disabled={!path} title={path ?? "This tab isn't showing a file from this computer."}
        onClick={() => { if (path) void copyText(path); onClose(); }}>
        <Icon name="copy" size={15} />Copy file path
      </button>
    </div>, document.body);
}
