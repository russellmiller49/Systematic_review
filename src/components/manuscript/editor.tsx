"use client";

import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  Quote,
  Redo2,
  Strikethrough,
  UnderlineIcon,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CitationNode } from "./citation-extension";

// TipTap instance — loaded ONLY via next/dynamic ssr:false (pdf-viewer precedent) and
// with immediatelyRender:false (App Router client components still SSR).
export default function ManuscriptEditor({
  initialContent,
  editable,
  onDocChange,
  onReady,
  toolbarExtra,
}: {
  initialContent: unknown;
  editable: boolean;
  onDocChange: (doc: unknown) => void;
  onReady?: (editor: Editor) => void;
  toolbarExtra?: React.ReactNode;
}) {
  const editor = useEditor(
    {
      extensions: [StarterKit.configure({ heading: { levels: [2, 3] } }), CitationNode],
      content: (initialContent as object) ?? { type: "doc", content: [] },
      editable,
      immediatelyRender: false,
      onUpdate: ({ editor }) => onDocChange(editor.getJSON()),
      onCreate: ({ editor }) => onReady?.(editor),
    },
    // Remount is driven by the parent's key={section.id}; editable toggles below.
    [],
  );

  if (editor && editor.isEditable !== editable) {
    editor.setEditable(editable);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {editable && editor && (
        <div className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
          <ToolbarButton
            active={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
            label="Bold"
          >
            <Bold />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            label="Italic"
          >
            <Italic />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("underline")}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            label="Underline"
          >
            <UnderlineIcon />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("strike")}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            label="Strikethrough"
          >
            <Strikethrough />
          </ToolbarButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolbarButton
            active={editor.isActive("heading", { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            label="Heading 2"
          >
            <span className="px-0.5 text-xs font-semibold">H2</span>
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("heading", { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            label="Heading 3"
          >
            <span className="px-0.5 text-xs font-semibold">H3</span>
          </ToolbarButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolbarButton
            active={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            label="Bullet list"
          >
            <List />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("orderedList")}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            label="Numbered list"
          >
            <ListOrdered />
          </ToolbarButton>
          <ToolbarButton
            active={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            label="Blockquote"
          >
            <Quote />
          </ToolbarButton>
          <span className="mx-1 h-5 w-px bg-border" />
          <ToolbarButton
            onClick={() => editor.chain().focus().undo().run()}
            label="Undo"
            active={false}
          >
            <Undo2 />
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().redo().run()}
            label="Redo"
            active={false}
          >
            <Redo2 />
          </ToolbarButton>
          {toolbarExtra}
        </div>
      )}
      <EditorContent
        editor={editor}
        className={cn(
          "prose-sm mt-3 min-h-[16rem] flex-1 overflow-y-auto text-sm leading-relaxed",
          "[&_.ProseMirror]:min-h-[16rem] [&_.ProseMirror]:outline-none",
          "[&_h2]:mt-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold",
          "[&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6",
          "[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:italic",
          "[&_p]:my-1.5",
        )}
      />
    </div>
  );
}

function ToolbarButton({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      className="h-7 px-2"
      onClick={onClick}
      title={label}
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  );
}
