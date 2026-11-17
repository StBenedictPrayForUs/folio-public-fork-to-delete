import type { ScanLanguage } from "./scanLanguage";
import { AnnotationMode, OPS, type PDFPageProxy } from "pdfjs-dist";
import type { Worker as OcrWorker } from "tesseract.js";
import { startOcrWorker, MissingScanPack } from "./ocrWorker";
import { ocrSession } from "./lib/ocr/session/OcrSession";
import { toItems } from "./lib/ocr/text/words";
import { area, boxOf, dropDuplicates } from "./lib/ocr/text/geometry";
import { imageCover, isScanLike, SCAN_TEXT_COVER, textCover } from "./lib/ocr/text/scan";
import type { Box, TextItem } from "./lib/ocr/types";
import type { EventBus, PDFPageView, PDFViewer } from "./viewer";

const IMAGE_OPS = new Set<number>([
  OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintInlineImageXObjectGroup,
  OPS.paintImageMaskXObjectGroup, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObjectRepeat,
]);

async function hasPageImage(page: PDFPageProxy) {
  if (page.imageCoordinates?.length) return true;
  // pdf.js records locations for ordinary images but not for stencil masks used by some monochrome scans.
  const { fnArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  return fnArray.some(op => IMAGE_OPS.has(op));
}

/** Path numbers (coordinates and drawing codes) above this mean a page draws more than rules and boxes:
 * letters drawn as outlines take thousands even for a few lines, while a ruled form takes a few hundred. */
export const VECTOR_TEXT_PATH_DATA = 1500;
/** ...and it must outweigh the page's real text by far: an outlined letter takes about 80 path numbers, so a page whose
 * drawing is mostly letters has hundreds of times more path data than real characters. A typed page with boxes or a
 * table (Folio's sample: 154 characters, about 4,500 path numbers) stays below this. */
export const PATH_DATA_PER_TEXT_CHAR = 60;

/** How much path data a page draws, counted from pdf.js's operator list, up to `limit`. */
async function pathData(page: PDFPageProxy, limit: number) {
  const { fnArray, argsArray } = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
  let total = 0;
  for (let i = 0; i < fnArray.length && total < limit; i++) {
    if (fnArray[i] !== OPS.constructPath) continue;
    // [paint operator, [path data], bounds]; older pdf.js passed the path's operators and arguments separately.
    const data = (argsArray[i] as unknown[])?.[1] as ArrayLike<unknown> | undefined;
    const first = data?.[0] as ArrayLike<number> | number | undefined;
    total += typeof first === "object" && first ? first.length : data?.length ?? 0;
  }
  return total;
}

/** A page whose words average below this confidence read poorly (often sideways); it is read again when the reader turns the pages. */
export const WEAK_READING = 70;

/** How well a page read: the sum and mean of its words' confidence. `known` is false for readings saved before Folio kept confidence. */
export function readingOf(items: readonly unknown[]) {
  const scores = (items as TextItem[]).flatMap(item => typeof item.confidence === "number" ? [item.confidence] : []);
  const total = scores.reduce((sum, score) => sum + score, 0);
  return { total, mean: scores.length ? total / scores.length : 0, known: scores.length > 0 || !items.length };
}

async function readWords(page: PDFPageProxy, worker: OcrWorker, signal: AbortSignal, dpi = 216, rotation = 0): Promise<ReturnType<typeof toItems>> {
  signal.throwIfAborted();
  // Read at a consistent resolution even in fit-page mode. Bound both dimensions on oversized scans.
  // (216 DPI is scale 3: the usual reading for scans. Pages of outlined letters get 300 DPI; they render without noise.)
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(dpi / 72, (dpi > 216 ? 3400 : 2400) / Math.max(base.width, base.height));
  // Read the page the way the reader has turned it: Tesseract only reads upright text.
  const viewport = page.getViewport({ scale, rotation: (page.rotate + rotation) % 360 });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const render = page.render({ canvas, viewport });
  const cancel = () => render.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    await render.promise;
    signal.throwIfAborted();
    // A language switch or document close can terminate the worker during image encoding.
    // Encode here so we can check ownership before Tesseract posts its recognition job.
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("Couldn't prepare the scan image."));
    }));
    signal.throwIfAborted();
    const bytes = new Uint8Array(await png.arrayBuffer());
    signal.throwIfAborted();
    const { data } = await worker.recognize(bytes, {}, { blocks: true, text: false });
    signal.throwIfAborted();
    const lines = (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(p => p.lines));
    return toItems(lines, viewport);
  } finally {
    signal.removeEventListener("abort", cancel);
    canvas.width = canvas.height = 0;
  }
}

/** Retain only sparse native text; typed pages can be skipped without accumulating their entire text. */
async function sparseNativeText(page: PDFPageProxy, signal: AbortSignal): Promise<TextItem[] | null> {
  const reader = page.streamTextContent().getReader();
  const items: TextItem[] = [];
  let coverage = 0;
  let typed = false;
  const pageArea = area(page.view as Box);
  try {
    for (;;) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) return typed ? null : items;
      if (typed) continue;
      for (const item of value.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const text = item as TextItem;
        items.push(text);
        coverage += area(boxOf(text));
        if (pageArea > 0 && coverage / pageArea >= SCAN_TEXT_COVER) {
          items.length = 0;
          typed = true;
          break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Prepare the document sequentially, giving the reader's current page and its successor the next turns. */
export function recognizeScannedPages(bus: EventBus, viewer: PDFViewer, languages: ScanLanguage[], onStatus: (text: string | null) => void, onPhase: (phase: "running" | "done") => void) {
  const pdf = viewer.pdfDocument!;
  const controller = new AbortController();
  const { signal } = controller;
  const pending = new Set(Array.from({ length: pdf.numPages }, (_, i) => i + 1));
  const notices = new Map<number, "noWords" | "ocrError" | "layerError">();
  let nextPage = viewer.currentPageNumber;
  let active = 0;
  let recognizing = false;
  let timer: number | undefined;
  let worker: Promise<OcrWorker> | undefined;
  let workerStartFailed = false;
  let missingPackMessage: string | undefined;
  /** The page rotation each page was last read at, and pages queued to be read again at the current one. */
  const readAt = new Map<number, number>();
  const rereads = new Set<number>();
  /** Queue a page to be read again at the current rotation if its last reading was poor. */
  function rereadIfWeak(n: number) {
    const session = ocrSession(pdf);
    if (!session || session.embedded.has(n) || readAt.get(n) === viewer.pagesRotation) return false;
    const items = session.pages.get(n);
    const reading = items && readingOf(items);
    if (!(reading ? reading.known && reading.mean < WEAK_READING : notices.get(n) === "noWords")) return false;
    if (items) rereads.add(n);
    else notices.delete(n);
    if (n !== active) pending.add(n);
    return true;
  }

  function updateStatus() {
    const n = viewer.currentPageNumber;
    const view: PDFPageView = viewer.getPageView(n - 1);
    const layer = view.textLayer?.div;
    if (notices.get(n) === "ocrError") onStatus(missingPackMessage ?? `Text unavailable on page ${n}.`);
    else if (layer?.isConnected && !layer.hidden && layer.textContent.trim()) onStatus(null);
    else if (notices.get(n) === "noWords") onStatus(`No readable text found on page ${n}.`);
    else if (notices.has(n)) onStatus(missingPackMessage ?? `Text unavailable on page ${n}.`);
    else if (active === n && recognizing) onStatus(`Recognizing text on page ${n}…`);
    else if (pending.has(n) || active === n || !layer?.isConnected || layer.hidden || !layer.querySelector(".endOfContent")) {
      onStatus(`Preparing text on page ${n}…`);
    } else onStatus(null);
  }

  function schedule() {
    if (!signal.aborted && !window.frameElement?.hasAttribute("inert") && !active && timer === undefined && pending.size) {
      timer = window.setTimeout(prepareNext, 0);
    }
  }

  async function prepareNext() {
    timer = undefined;
    if (!pending.size || signal.aborted || window.frameElement?.hasAttribute("inert")) return;
    // Start at the last jump, continue ahead of the reader, then wrap back to the beginning.
    while (!pending.has(nextPage)) nextPage = nextPage % pdf.numPages + 1;
    const n = nextPage;
    nextPage = n % pdf.numPages + 1;
    pending.delete(n);
    active = n;
    const view: PDFPageView = viewer.getPageView(n - 1);
    let page: PDFPageProxy | undefined;
    try {
      page = await pdf.getPage(n);
      signal.throwIfAborted();
      const session = ocrSession(pdf);
      const again = rereads.delete(n);
      if (session?.embedded.has(n) || (session?.pages.has(n) && !again)) return;
      const rotation = viewer.pagesRotation;
      // Read again: judge the page by its own text, not the words recognized on it last time.
      const native = again && session ? await session.withoutRecognized(n, () => sparseNativeText(page!, signal))
        : await sparseNativeText(page, signal);
      if (!native) return;
      signal.throwIfAborted();
      const sparse = textCover(native, page.view as Box) < SCAN_TEXT_COVER;
      let outlined = false;
      if (!(await hasPageImage(page))) {
        // No picture, so not a scan. But some PDFs draw their letters as shapes instead of text (a "print to PDF"
        // that outlined its fonts): little or no real text and a lot of drawing means words to read.
        const chars = native.reduce((sum, item) => sum + item.str.trim().length, 0);
        const needed = Math.max(VECTOR_TEXT_PATH_DATA, PATH_DATA_PER_TEXT_CHAR * chars);
        if (!sparse || await pathData(page, needed) < needed) return;
        outlined = true;
      }
      const scan = outlined || await isScanLike(native.length, textCover(native, page.view as Box), async () => {
        const { fnArray, argsArray } = await page!.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
        return imageCover(fnArray, argsArray, OPS, page!.view as Box);
      });
      if (!scan) return;
      signal.throwIfAborted();
      if (n !== viewer.currentPageNumber && pending.has(viewer.currentPageNumber)) {
        pending.add(n);
        return;
      }
      recognizing = true;
      if (n === viewer.currentPageNumber) updateStatus();
      worker ??= startOcrWorker(signal, languages).catch(error => { workerStartFailed = true; missingPackMessage = error instanceof MissingScanPack ? error.message : undefined; throw error; });
      const items = await readWords(page, await worker, signal, outlined ? 300 : 216, rotation);
      const newItems = dropDuplicates(items, native.map(boxOf));
      signal.throwIfAborted();
      readAt.set(n, rotation);
      if (again && session?.pages.has(n)) {
        // Keep whichever reading is better; the page's text layer is rebuilt either way.
        if (readingOf(newItems).total > readingOf(session.pages.get(n)!).total) session.replace(n, newItems);
        if (view.renderingState !== 0) {
          view.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepCanvasWrapper: true });
          viewer.update();
        }
      } else if (newItems.length && session) {
        notices.delete(n);
        session.record(n, newItems);
        // Rebuild through pdf.js so its text spans and find-highlighter map stay in sync.
        if (view.renderingState !== 0) {
          view.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepCanvasWrapper: true });
          viewer.update();
        }
      } else {
        notices.set(n, "noWords");
      }
    } catch (error) {
      if (!signal.aborted) {
        notices.set(n, "ocrError");
        console.warn("Page OCR failed", error);
      }
    } finally {
      active = 0;
      recognizing = false;
      // The reader turned the pages while this one was being read.
      if (!signal.aborted && readAt.has(n) && readAt.get(n) !== viewer.pagesRotation) rereadIfWeak(n);
      if (!signal.aborted) {
        // Background renders aren't in the viewer's page buffer, so it won't release their images for us.
        if (!viewer.getCachedPageViews().has(view)) page?.cleanup();
        if (n === viewer.currentPageNumber) updateStatus();
        if (!pending.size) onPhase("done");
        schedule();
      }
    }
  }

  bus.on("textlayerrendered", ({ source: view, pageNumber: n, error }: { source: PDFPageView; pageNumber: number; error: unknown }) => {
    if (error) {
      notices.set(n, "layerError");
      if (n === viewer.currentPageNumber) updateStatus();
      return;
    }
    if (notices.get(n) === "layerError") notices.delete(n);
    if (ocrSession(pdf)?.pages.has(n)) view.textLayer?.div.classList.add("ocr-text");
    if (n === viewer.currentPageNumber) updateStatus();
    schedule();
  }, { signal });
  bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
    nextPage = pageNumber;
    if (notices.get(pageNumber) === "ocrError") {
      notices.delete(pageNumber);
      if (workerStartFailed) { worker = undefined; workerStartFailed = false; }
      if (pageNumber !== active) pending.add(pageNumber);
    }
    updateStatus();
    schedule();
  }, { signal });
  // Turning the pages (the R key or the rotate button) reads poorly read pages again the new way up. Pages that read
  // well are left alone, so an upright document costs nothing; a sideways one is read once more, a page at a time.
  bus.on("rotationchanging", ({ pagesRotation }: { pagesRotation: number }) => {
    if (pagesRotation !== viewer.pagesRotation) return;
    for (let n = 1; n <= pdf.numPages; n++) rereadIfWeak(n);
    if (pending.size) {
      nextPage = viewer.currentPageNumber;
      onPhase("running");
      updateStatus();
      schedule();
    }
  }, { signal });
  window.addEventListener("folio:tab-visibility", schedule, { signal });
  const stop = () => {
    controller.abort();
    window.clearTimeout(timer);
    pending.clear();
    onStatus(null);
    void worker?.then(w => w.terminate()).catch(() => {});
  };
  onPhase("running");
  updateStatus();
  schedule();
  return {
    stop,
    retry() {
      if (signal.aborted) return;
      if (workerStartFailed) { worker = undefined; workerStartFailed = false; }
      for (let n = 1; n <= pdf.numPages; n++) {
        if (n !== active && !ocrSession(pdf)?.pages.has(n) && !ocrSession(pdf)?.embedded.has(n)) pending.add(n);
        if (notices.get(n) === "ocrError") notices.delete(n);
      }
      nextPage = viewer.currentPageNumber;
      if (pending.size || active) onPhase("running");
      updateStatus();
      schedule();
    },
  };
}
