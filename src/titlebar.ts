/** Electron reads draggable regions from the window document. Mirror the reader's title bar
 * geometry there, leaving its buttons, tabs, and the native window controls interactive. */
const INTERACTIVE = "button, input, select, .document-tab-list";

export function trackTitlebar(header: HTMLElement) {
  const host = window.parent.document;
  const area = host.createElement("div");
  area.className = "window-drag-area";
  area.setAttribute("aria-hidden", "true");
  host.body.append(area);
  let frame = 0;
  const update = () => {
    frame = 0;
    const style = getComputedStyle(header);
    const left = parseFloat(style.paddingLeft);
    area.style.insetInline = left + "px " + style.paddingRight;
    area.style.height = header.clientHeight + "px";
    area.replaceChildren(...Array.from(header.querySelectorAll<HTMLElement>(INTERACTIVE), control => {
      const { left: x, width } = control.getBoundingClientRect();
      const hole = host.createElement("span");
      hole.style.left = x - left + "px";
      hole.style.width = width + "px";
      return hole;
    }));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
  // Tabs and buttons come and go (opening documents, edit mode), so watch the header's contents too.
  const resize = new ResizeObserver(schedule);
  resize.observe(header);
  const observeControls = () => header.querySelectorAll(INTERACTIVE).forEach(control => resize.observe(control));
  const mutations = new MutationObserver(() => { observeControls(); schedule(); });
  mutations.observe(header, { childList: true, subtree: true });
  observeControls();
  update();
  return () => { cancelAnimationFrame(frame); resize.disconnect(); mutations.disconnect(); area.remove(); };
}
