import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Button } from '@astryxdesign/core/Button';
import { ImagePlus } from 'lucide-react';
import { $createImageNode, activeEditor$, useCellValue } from '@mdxeditor/editor';
import { $createParagraphNode, $createRangeSelection, $getNodeByKey, $getRoot, $getSelection, $insertNodes, $isRangeSelection, $isRootOrShadowRoot, $setSelection, getNearestEditorFromDOMNode, type BaseSelection, type LexicalEditor } from 'lexical';
import { EDITOR_IMAGE_ACCEPT, isWorkspaceImageDrag, readWorkspaceImageDrag, validateEditorImage, type WorkspaceImageDrag } from '../utils/editorImages';

type InsertionPoint = { editor: LexicalEditor; selection: BaseSelection | null; document: string };

type MarkdownImageControlsProps = {
  containerRef: RefObject<HTMLDivElement | null>;
  onImageUpload: (image: File) => Promise<string>;
  onWorkspaceImageDrop?: (image: WorkspaceImageDrag) => Promise<string>;
  onStatusChange: (message: string, isError?: boolean) => void;
};

function captureInsertion(editor: LexicalEditor, event?: DragEvent): InsertionPoint {
  let selection: BaseSelection | null = null;
  editor.read(() => {
    selection = $getSelection()?.clone() ?? null;
    if (!event) return;
    const doc = editor.getRootElement()?.ownerDocument;
    const range = doc?.caretRangeFromPoint?.(event.clientX, event.clientY);
    if (range && editor.getRootElement()?.contains(range.startContainer)) {
      // Decorator nodes (images/code editors) may not expose a text caret.
      // Preserve the last valid selection when the browser cannot map one.
      try {
        const point = $createRangeSelection();
        point.applyDOMRange(range);
        selection = point;
      } catch { /* Use the captured selection, or the document end. */ }
    }
  });
  return { editor, selection, document: JSON.stringify(editor.getEditorState().toJSON()) };
}

export function MarkdownImageControls({ containerRef, onImageUpload, onWorkspaceImageDrop, onStatusChange }: MarkdownImageControlsProps) {
  const editor = useCellValue(activeEditor$);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const insertionRef = useRef<InsertionPoint | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (busyRef.current) onStatusChange('');
    };
  }, [onStatusChange]);

  const insertImages = useCallback(async (point: InsertionPoint, sources: { name: string; load: () => Promise<string> }[]) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    onStatusChange('Adding image…');
    try {
      const images = await Promise.all(sources.map(async source => ({ name: source.name, src: await source.load() })));
      if (!mountedRef.current || !point.editor.getRootElement()) return;
      point.editor.read(() => {});
      if (JSON.stringify(point.editor.getEditorState().toJSON()) !== point.document) {
        throw new Error('The document changed while the image was loading. Insert it again at your cursor.');
      }
      point.editor.update(() => {
        const selection = point.selection?.clone() ?? null;
        if ($isRangeSelection(selection) && $getNodeByKey(selection.anchor.key) && $getNodeByKey(selection.focus.key)) {
          $setSelection(selection);
        } else {
          $getRoot().selectEnd();
        }
        for (const image of images) {
          const node = $createImageNode({ src: image.src, altText: image.name });
          $insertNodes([node]);
          if ($isRootOrShadowRoot(node.getParentOrThrow())) {
            const paragraph = $createParagraphNode();
            node.replace(paragraph);
            paragraph.append(node).selectEnd();
          }
        }
      });
      onStatusChange(images.length === 1 ? 'Image added.' : `${images.length} images added.`);
    } catch (error) {
      if (mountedRef.current) onStatusChange(error instanceof Error ? error.message : 'The image could not be added. Please try again.', true);
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [onStatusChange]);

  const insertFiles = useCallback((point: InsertionPoint, files: File[]) => {
    if (!files.length) return;
    void insertImages(point, files.map(file => ({ name: file.name, load: async () => {
      validateEditorImage(file);
      return onImageUpload(file);
    } })));
  }, [insertImages, onImageUpload]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const eventEditor = (target: EventTarget | null) => target instanceof Node ? getNearestEditorFromDOMNode(target) ?? editor : editor;
    const isCanvasTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest('[contenteditable="true"]') && !target.closest('.cm-editor');
    const dragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !isCanvasTarget(event.target)) return;
      if (isWorkspaceImageDrag(event.dataTransfer) || Array.from(event.dataTransfer.types).includes('application/x-helpudoc-workspace-file-id')
        || Array.from(event.dataTransfer.items).some(item => item.type.startsWith('image/'))) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = 'copy';
        container.dataset.imageDropActive = 'true';
      }
    };
    const dragLeave = () => { delete container.dataset.imageDropActive; };
    const drop = (event: DragEvent) => {
      dragLeave();
      const targetEditor = eventEditor(event.target);
      if (!event.dataTransfer || !targetEditor || !isCanvasTarget(event.target)) return;
      const workspaceImage = readWorkspaceImageDrag(event.dataTransfer);
      const files = Array.from(event.dataTransfer.files).filter(file => file.type.startsWith('image/'));
      const workspaceFile = isWorkspaceImageDrag(event.dataTransfer)
        || Array.from(event.dataTransfer.types).includes('application/x-helpudoc-workspace-file-id');
      if (workspaceFile && !workspaceImage) {
        event.preventDefault();
        event.stopPropagation();
        onStatusChange('Choose a PNG, JPEG, GIF, or WebP image from Files.', true);
        return;
      }
      if (!workspaceImage && !files.length) return;
      event.preventDefault();
      event.stopPropagation();
      const point = captureInsertion(targetEditor, event);
      if (workspaceImage) {
        if (onWorkspaceImageDrop) void insertImages(point, [{ name: workspaceImage.name, load: () => onWorkspaceImageDrop(workspaceImage) }]);
        else onStatusChange('Open this image from the current workspace to insert it.', true);
      } else insertFiles(point, files);
    };
    const paste = (event: ClipboardEvent) => {
      const targetEditor = eventEditor(event.target);
      if (!targetEditor || !isCanvasTarget(event.target) || !event.clipboardData) return;
      const files = Array.from(event.clipboardData.files).filter(file => file.type.startsWith('image/'));
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      insertFiles(captureInsertion(targetEditor), files);
    };
    container.addEventListener('dragover', dragOver, true);
    container.addEventListener('dragleave', dragLeave, true);
    container.addEventListener('drop', drop, true);
    container.addEventListener('paste', paste, true);
    return () => {
      container.removeEventListener('dragover', dragOver, true);
      container.removeEventListener('dragleave', dragLeave, true);
      container.removeEventListener('drop', drop, true);
      container.removeEventListener('paste', paste, true);
    };
  }, [containerRef, editor, insertFiles, insertImages, onWorkspaceImageDrop, onStatusChange]);

  return <>
    <Button label="Insert image" variant="ghost" size="sm" isDisabled={busy}
      onMouseDown={event => event.preventDefault()}
      onClick={() => { insertionRef.current = editor ? captureInsertion(editor) : null; pickerRef.current?.click(); }}>
      <ImagePlus size={17} aria-hidden="true" />
    </Button>
    <input ref={pickerRef} type="file" accept={EDITOR_IMAGE_ACCEPT} multiple hidden aria-label="Choose image" onChange={event => {
      const files = Array.from(event.target.files ?? []);
      const point = insertionRef.current ?? (editor ? captureInsertion(editor) : null);
      if (point) insertFiles(point, files);
      insertionRef.current = null;
      event.target.value = '';
    }} />
  </>;
}
