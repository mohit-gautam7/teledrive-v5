import { File } from "@shared/types";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cloud, HardDrive, Download, Trash2, Share2, Play } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

interface FileGridProps {
  files: any[];
}

export function FileGrid({ files }: FileGridProps) {
  const deleteFile = trpc.files.delete.useMutation();
  const shareFile = trpc.files.share.useMutation();

  const handleDelete = async (fileId: number) => {
    if (confirm("Are you sure you want to delete this file?")) {
      try {
        await deleteFile.mutateAsync({ fileId });
        toast.success("File deleted successfully");
      } catch (error) {
        toast.error("Failed to delete file");
      }
    }
  };

  const handleShare = async (fileId: number) => {
    try {
      const result = await shareFile.mutateAsync({ fileId });
      const shareUrl = `${window.location.origin}${result.shareUrl}`;
      navigator.clipboard.writeText(shareUrl);
      toast.success("Share link copied to clipboard");
    } catch (error) {
      toast.error("Failed to create share link");
    }
  };

  const getStorageIcon = (storageMode: string) => {
    if (storageMode === "botStorage") {
      return <Cloud className="w-4 h-4 text-blue-500" />;
    }
    return <HardDrive className="w-4 h-4 text-purple-500" />;
  };

  const getStorageLabel = (storageMode: string) => {
    if (storageMode === "botStorage") {
      return "Image Storage";
    }
    return "Video Storage";
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const isVideo = (mimeType?: string) => mimeType?.startsWith("video/");
  const isImage = (mimeType?: string) => mimeType?.startsWith("image/");

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {files.map((file) => (
        <Card key={file.id} className="bg-slate-800 border-slate-700 overflow-hidden hover:border-slate-600 transition">
          {/* Thumbnail */}
          <div className="relative bg-slate-700 h-32 flex items-center justify-center">
            {isImage(file.mimeType) ? (
              <img
                src={file.thumbnailUrl || ""}
                alt={file.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = "none";
                }}
              />
            ) : isVideo(file.mimeType) ? (
              <Play className="w-12 h-12 text-purple-400" />
            ) : (
              <HardDrive className="w-12 h-12 text-slate-500" />
            )}
            {/* Storage Mode Badge */}
            <div className="absolute top-2 right-2 bg-slate-900/80 rounded-full p-2">
              {getStorageIcon(file.storageMode)}
            </div>
          </div>

          <CardContent className="pt-4 space-y-3">
            {/* File Info */}
            <div className="space-y-1">
              <p className="text-white font-medium truncate text-sm">{file.name}</p>
              <p className="text-xs text-slate-400">{formatFileSize(file.size)}</p>
              <div className="flex items-center gap-1 text-xs text-slate-400">
                {getStorageIcon(file.storageMode)}
                <span>{getStorageLabel(file.storageMode)}</span>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-xs h-8"
                onClick={() => handleShare(file.id)}
              >
                <Share2 className="w-3 h-3 mr-1" />
                Share
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-xs h-8 text-red-400 hover:text-red-300"
                onClick={() => handleDelete(file.id)}
              >
                <Trash2 className="w-3 h-3 mr-1" />
                Delete
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
