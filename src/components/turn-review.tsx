import { useMemo, useRef, useState } from "react";
import { ArrowsHorizontal, TextAlignLeft, TextColumns, ArrowSquareOut, CaretDown, Check } from "@phosphor-icons/react";
import * as Select from "@radix-ui/react-select";
import { comparisonRows, unifiedRows, type SourceChange } from "@/lib/turn-changes";
import { fileName, documentLanguage, type PreviewDocument } from "@/components/document-preview-context";

export function TurnReview({ files, onOpen }: { files: SourceChange[]; onOpen: (document: PreviewDocument) => void }) {
  const [path, setPath] = useState("");
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [page, setPage] = useState(0);
  const leftColumn = useRef<HTMLDivElement>(null);
  const rightColumn = useRef<HTMLDivElement>(null);
  const file = files.find(file => file.path === path) ?? files[0];
  const drawSplit = split && Boolean(file?.before && file.after);
  const rows = useMemo(() => file ? comparisonRows(file) : [], [file]);
  const displayedRows = useMemo(() => rows && (drawSplit ? rows : unifiedRows(rows)), [rows, drawSplit]);
  const counts = useMemo(() => ({ added: rows?.filter(row => row.kind === "change" && row.after !== undefined).length ?? 0,
    removed: rows?.filter(row => row.kind === "change" && row.before !== undefined).length ?? 0 }), [rows]);
  const pages = Math.max(1, Math.ceil((displayedRows?.length ?? 0) / 300));
  const currentPage = Math.min(page, pages - 1);
  const visible = displayedRows?.slice(currentPage * 300, (currentPage + 1) * 300);
  return <section className="turn-review" aria-label="本轮代码差异">
    <header className="review-toolbar"><Select.Root value={file?.path ?? ""} onValueChange={value => { setPath(value); setPage(0); }}>
      <Select.Trigger className="review-file-selector" aria-label="选择改动文件" disabled={!file}><Select.Value>{file ? fileName(file.path) : "本轮改动"}</Select.Value><Select.Icon><CaretDown size={12} /></Select.Icon></Select.Trigger>
      <Select.Portal><Select.Content className="review-file-menu" position="popper" align="start" sideOffset={4}><Select.Viewport>{files.map(file => <Select.Item className="review-file-option" key={file.path} value={file.path}><Select.ItemText>{file.path}</Select.ItemText><Select.ItemIndicator><Check size={12} /></Select.ItemIndicator></Select.Item>)}</Select.Viewport></Select.Content></Select.Portal>
    </Select.Root>
      {file && <span className="review-counts"><span>+{counts.added}</span><span>−{counts.removed}</span></span>}
      <div className="review-tools"><button type="button" aria-label="并排对比" aria-pressed={split} onClick={() => { setSplit(value => !value); setPage(0); }}><ArrowsHorizontal size={15} /></button><button type="button" aria-label="差异自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>{wrap ? <TextAlignLeft size={15} /> : <TextColumns size={15} />}</button><button type="button" aria-label="打开改动文件" disabled={!file} onClick={() => file && onOpen({ id: file.path, path: file.path, title: fileName(file.path), language: documentLanguage(file.path), code: file.after, loadFromDisk: true })}><ArrowSquareOut size={15} /></button></div>
    </header>
    {!file ? <p className="code-work-empty">本轮还没有记录到文本修改。</p> : !rows ? <p className="code-work-empty">文件差异过于复杂，请打开改动文件查看。</p> : <>
      {file.before === null && <p className="review-note">本轮新建的文件</p>}
      <div className="review-body" data-split={drawSplit} data-wrap={wrap}>
        {drawSplit && !wrap ? <div className="review-columns">{(["before", "after"] as const).map((side, sideIndex) => <div className="review-column" key={side} ref={sideIndex ? rightColumn : leftColumn}
          onScroll={event => { const peer = (sideIndex ? leftColumn : rightColumn).current; if (peer && peer.scrollTop !== event.currentTarget.scrollTop) peer.scrollTop = event.currentTarget.scrollTop; }}>
          {visible?.map((row, index) => <div className={`review-side-line ${row.kind === "change" && row[side] !== undefined ? sideIndex ? "review-add" : "review-delete" : ""}`} key={index}><span>{sideIndex ? row.newLine : row.oldLine}</span><code>{row[side] ?? ""}</code></div>)}
        </div>)}</div> : visible?.map((row, index) => drawSplit ? <div className="review-split-line" key={index}>
          <div className={row.kind === "change" && row.before !== undefined ? "review-delete" : ""}><span>{row.oldLine}</span><code>{row.before ?? ""}</code></div>
          <div className={row.kind === "change" && row.after !== undefined ? "review-add" : ""}><span>{row.newLine}</span><code>{row.after ?? ""}</code></div>
        </div> : row.kind === "context" ? <div className="review-line" key={index}><span>{row.oldLine}</span><span>{row.newLine}</span><span /><code>{row.after}</code></div> : <div key={index}>
          {row.before !== undefined && <div className="review-line review-delete"><span>{row.oldLine}</span><span /><span>−</span><code>{row.before}</code></div>}
          {row.after !== undefined && <div className="review-line review-add"><span /><span>{row.newLine}</span><span>+</span><code>{row.after}</code></div>}
        </div>)}
      </div>
      {pages > 1 && <footer className="review-pagination"><button type="button" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button><span>{currentPage + 1} / {pages}</span><button type="button" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button></footer>}
    </>}
  </section>;
}
