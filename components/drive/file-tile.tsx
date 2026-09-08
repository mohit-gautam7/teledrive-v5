"use client";

import { memo, useState } from "react";
import { motion } from "framer-motion";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  File as FileIcon,
  FolderInput,
  Image as ImageIcon,
  Info,
  Link2,
  MoreVertical,
  Pencil,
  RotateCw,
  Sparkles,
  Star,
  Trash2,
  Video as VideoIcon
} from "lucide-react";
import { cn, formatBytes } from "@/lib/utils";
import { popIn, stagger, useReducedMotion } from "@/lib/motion";
import { aiActionsFor, type AiAction } from "./ai";
import { useAssetUrl } from "@/lib/use-file-auth";
import { type DriveFile, telegramDeepLink } from "./types";

export type TileActions = {
  onPreview: () => void;
  onDownload: () => void;
  onShare: () => void;
  onDelete: () => void;
  onFavorite: () => void;
  onRestore: () => void;
  onRename: () => void;
  onMove: () => void;
  onProperties: () => void;
  onToggleSelect: () => void;
  /** Only supplied when AI exists on this server; absent hides the whole
   *  submenu, so a build with AI_ENABLED unset never shows it. */
  onAskAi?: (action?: AiAction) => void;
};

function FileTileBase({
  file,
  grid,
  index,
  inTrash,
  selected,
  selectionActive,
  mtprotoUserId,
  actions
}: {
  file: DriveFile;
  grid: boolean;
  index: number;
  inTrash: boolean;
  selected: boolean;
  selectionActive: boolean;
  mtprotoUserId: string | null;
  actions: TileActions;
}) {
  const reduceMotion = useReducedMotion();
  const [loaded, setLoaded] = useState(false);
  // Controlled so a right-click can open the same menu the ⋮ button opens.
  // Radix anchors it to the trigger rather than the pointer, which is a small
  // price for not shipping a second menu implementation that would drift.
  const [menuOpen, setMenuOpen] = useState(false);
  const image = file.mimeType.startsWith("image/");
  // Hoisted out of the JSX because it is a hook: the thumbnail source has to be
  // resolved unconditionally, whether or not this tile happens to be an image.
  const thumbSrc = useAssetUrl(`/api/preview/${file.id}?thumb=1`);
  const video = file.mimeType.startsWith("video/");
  const Icon = image ? ImageIcon : video ? VideoIcon : FileIcon;
  const deepLink = telegramDeepLink(file, mtprotoUserId);
  // A trashed file is not processed: the AI actions read the bytes back out of
  // Telegram, and restoring first is the honest order of operations.
  const aiActions = actions.onAskAi && !inTrash ? aiActionsFor(file) : [];

  const menu = (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align="end" sideOffset={6} className="menu">
        {inTrash ? (
          <DropdownMenu.Item onSelect={actions.onRestore} className="menu-item">
            <RotateCw className="h-4 w-4" style={{ color: "var(--emerald)" }} /> Restore
          </DropdownMenu.Item>
        ) : null}
        <DropdownMenu.Item onSelect={actions.onDownload} className="menu-item">
          <Download className="h-4 w-4" style={{ color: "var(--accent)" }} /> Download
        </DropdownMenu.Item>
        {!inTrash ? (
          <>
            <DropdownMenu.Item onSelect={actions.onShare} className="menu-item">
              <Link2 className="h-4 w-4" style={{ color: "var(--accent)" }} /> Share link
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={actions.onFavorite} className="menu-item">
              <Star className="h-4 w-4" style={{ color: "var(--amber)", fill: file.isFavorite ? "var(--amber)" : "none" }} />
              {file.isFavorite ? "Unfavourite" : "Favourite"}
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={actions.onRename} className="menu-item">
              <Pencil className="h-4 w-4" style={{ color: "var(--accent)" }} /> Rename
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={actions.onMove} className="menu-item">
              <FolderInput className="h-4 w-4" style={{ color: "var(--accent)" }} /> Move to…
            </DropdownMenu.Item>
            <DropdownMenu.Item onSelect={actions.onToggleSelect} className="menu-item">
              <Check className="h-4 w-4" style={{ color: "var(--accent)" }} /> {selected ? "Deselect" : "Select"}
            </DropdownMenu.Item>
            {deepLink ? (
              <DropdownMenu.Item onSelect={() => window.open(deepLink, "_blank", "noopener")} className="menu-item">
                <ExternalLink className="h-4 w-4" style={{ color: "var(--accent)" }} /> Open in Telegram
              </DropdownMenu.Item>
            ) : null}
            {aiActions.length ? (
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger className="menu-item justify-between">
                  <span className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4" style={{ color: "var(--accent)" }} /> Ask AI
                  </span>
                  <ChevronRight className="h-3.5 w-3.5" style={{ color: "var(--text-3)" }} />
                </DropdownMenu.SubTrigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.SubContent sideOffset={4} className="menu">
                    {aiActions.map(a => (
                      <DropdownMenu.Item key={a.id} onSelect={() => actions.onAskAi?.(a.id)} className="menu-item">
                        <a.icon className="h-4 w-4" style={{ color: "var(--accent)" }} /> {a.label}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.SubContent>
                </DropdownMenu.Portal>
              </DropdownMenu.Sub>
            ) : null}
            <DropdownMenu.Item onSelect={actions.onProperties} className="menu-item">
              <Info className="h-4 w-4" style={{ color: "var(--accent)" }} /> Properties
            </DropdownMenu.Item>
          </>
        ) : null}
        <DropdownMenu.Item onSelect={actions.onDelete} className="menu-item menu-item-danger">
          <Trash2 className="h-4 w-4" /> {inTrash ? "Delete forever" : "Move to trash"}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );

  return (
    <motion.article
      // Position only: a full layout animation would animate width and height
      // too, which is a reflow of the whole grid on every frame.
      layout={reduceMotion ? false : "position"}
      {...popIn(reduceMotion, stagger(index))}
      draggable={!inTrash}
      // framer-motion types onDragStart as its own gesture event; this is the
      // native HTML5 one, hence the cast.
      onDragStart={event => {
        const { dataTransfer } = event as unknown as React.DragEvent<HTMLElement>;
        if (!dataTransfer) return;
        // Payload read by folder cards to move files by drag-and-drop.
        dataTransfer.setData("application/x-teledrive-files", JSON.stringify(selected ? "selection" : [file.id]));
        dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={event => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      className={cn("card group relative overflow-hidden p-3", !grid && "flex items-center gap-3")}
      style={{
        borderColor: selected ? "var(--accent)" : undefined,
        background: selected ? "var(--accent-dim)" : undefined
      }}
    >
      {/* Thumbnail / icon */}
      <div
        className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-lg", grid ? "mb-3 aspect-[4/3] w-full" : "h-11 w-11")}
        style={{ background: "var(--surface)", cursor: selectionActive ? "pointer" : "zoom-in" }}
        onClick={() => (selectionActive ? actions.onToggleSelect() : actions.onPreview())}
      >
        {image && !file.unreachable ? (
          <>
            {!loaded ? <span className="skeleton absolute inset-0" /> : null}
            <img
              src={thumbSrc}
              alt=""
              loading="lazy"
              decoding="async"
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(true)}
              // Never gated on load state — an image that completes before
              // onLoad is attached would stay invisible. The skeleton sits
              // behind it and is removed once the image reports in.
              className="relative h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
            />
          </>
        ) : (
          <Icon className={grid ? "h-8 w-8" : "h-5 w-5"} style={{ color: "var(--text-3)" }} />
        )}

        {file.unreachable ? (
          <span
            className="chip absolute bottom-1.5 left-1.5"
            style={{ color: "var(--amber)", borderColor: "var(--amber)" }}
            title="Telegram will not serve this file back to a bot — it was stored as a single document over 20 MB. Re-upload it to fix."
          >
            RE-UPLOAD
          </span>
        ) : video ? (
          <span className="chip absolute bottom-1.5 right-1.5">VIDEO</span>
        ) : null}

        {/* Selection toggle — always visible once a selection exists */}
        <button
          onClick={e => {
            e.stopPropagation();
            actions.onToggleSelect();
          }}
          className={cn(
            "absolute left-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg transition",
            selected || selectionActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          )}
          style={{
            background: selected ? "var(--accent)" : "rgba(4,6,12,0.66)",
            border: `1px solid ${selected ? "var(--accent)" : "var(--border-med)"}`
          }}
          aria-label={selected ? "Deselect" : "Select"}
          aria-pressed={selected}
        >
          <Check className="h-4 w-4" style={{ color: selected ? "#04070c" : "var(--text-2)" }} />
        </button>

        {grid && !inTrash ? (
          <button
            onClick={e => {
              e.stopPropagation();
              actions.onFavorite();
            }}
            className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-lg transition"
            style={{ background: "rgba(4,6,12,0.66)", border: "1px solid var(--border-med)" }}
            aria-label={file.isFavorite ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={file.isFavorite}
          >
            <Star className="h-3.5 w-3.5" style={{ color: file.isFavorite ? "var(--amber)" : "var(--text-3)", fill: file.isFavorite ? "var(--amber)" : "none" }} />
          </button>
        ) : null}
      </div>

      {/* Meta */}
      <div className="min-w-0 flex-1">
        <h3 className="t-sm truncate font-semibold" style={{ color: "var(--text-1)" }} title={file.originalName}>
          {file.originalName}
        </h3>
        <p className="mono truncate" style={{ color: "var(--text-3)" }}>
          {formatBytes(file.size)}
          {file.backend === "mtproto" ? " · account" : ""}
          {file.isFavorite && !grid ? " · ★" : ""}
        </p>
      </div>

      {/* Actions: a single overflow menu at every breakpoint keeps the tile calm
          and removes the row of buttons that used to overflow on phones. */}
      <div className={cn("flex items-center gap-1.5", grid ? "mt-3" : "ml-auto")}>
        {grid ? (
          <>
            <button onClick={actions.onDownload} className="icon-btn flex-1" style={{ width: "auto" }} aria-label="Download">
              <Download className="h-4 w-4" />
            </button>
            {!inTrash ? (
              <button onClick={actions.onShare} className="icon-btn flex-1" style={{ width: "auto" }} aria-label="Share">
                <Link2 className="h-4 w-4" />
              </button>
            ) : (
              <button onClick={actions.onRestore} className="icon-btn flex-1" style={{ width: "auto", color: "var(--emerald)" }} aria-label="Restore">
                <RotateCw className="h-4 w-4" />
              </button>
            )}
          </>
        ) : null}
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button className="icon-btn" aria-label="More actions">
              <MoreVertical className="h-4 w-4" />
            </button>
          </DropdownMenu.Trigger>
          {menu}
        </DropdownMenu.Root>
      </div>
    </motion.article>
  );
}

// Tiles re-render on every list mutation otherwise; memoising keeps large
// folders smooth on a phone.
export const FileTile = memo(FileTileBase);
