import { useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cloud, Upload, AlertCircle, Cloud as CloudIcon, HardDrive, Info } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface UploadingFile {
  id: string;
  name: string;
  size: number;
  progress: number;
  storageMode: "botStorage" | "personalSavedMessages";
  routingReason: string;
  explanation: string;
  displayName: string;
  canOverride: boolean;
  overrideOptions?: ("botStorage" | "personalSavedMessages")[];
}

export function AdvancedUploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFiles, setUploadingFiles] = useState<UploadingFile[]>([]);
  const [expandedFileId, setExpandedFileId] = useState<string | null>(null);

  const getRoutingDecision = trpc.routing.getDecision.useQuery(
    { filename: "", size: 0 },
    { enabled: false }
  );

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    handleFiles(files);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const files = Array.from(e.target.files);
      handleFiles(files);
    }
  };

  const handleFiles = async (files: File[]) => {
    const FIFTY_MB = 52428800;

    for (const file of files) {
      const fileId = `file_${Date.now()}_${Math.random()}`;

      // Get routing decision
      try {
        const result = await getRoutingDecision.refetch();
        if (!result.data) throw new Error("No routing data");

        const decision = result.data;

        // Determine if override is possible
        const canOverride =
          (decision.storageMode === "botStorage" && file.size <= FIFTY_MB) ||
          (decision.storageMode === "personalSavedMessages");

        const overrideOptions: ("botStorage" | "personalSavedMessages")[] = [];
        if (file.size <= FIFTY_MB) {
          overrideOptions.push("botStorage");
        }
        overrideOptions.push("personalSavedMessages");

        const newFile: UploadingFile = {
          id: fileId,
          name: file.name,
          size: file.size,
          progress: 0,
          storageMode: decision.storageMode as "botStorage" | "personalSavedMessages",
          routingReason: decision.routingReason,
          explanation: decision.explanation,
          displayName: decision.displayName,
          canOverride,
          overrideOptions,
        };

        setUploadingFiles((prev) => [...prev, newFile]);

        // Simulate upload progress
        for (let i = 0; i <= 100; i += 10) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.id === fileId ? { ...f, progress: i } : f
            )
          );
        }

        // Remove from uploading list after completion
        setTimeout(() => {
          setUploadingFiles((prev) => prev.filter((f) => f.id !== fileId));
          toast.success(`${file.name} uploaded successfully`);
        }, 500);
      } catch (error) {
        console.error("Failed to get routing decision:", error);
        toast.error("Failed to determine storage location");
      }
    }
  };

  const getStorageIcon = (mode: string) => {
    if (mode === "botStorage") {
      return <CloudIcon className="w-4 h-4 text-blue-500" />;
    }
    return <HardDrive className="w-4 h-4 text-purple-500" />;
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const batchSummary = uploadingFiles.length > 0 && {
    total: uploadingFiles.length,
    botCount: uploadingFiles.filter((f) => f.storageMode === "botStorage").length,
    personalCount: uploadingFiles.filter((f) => f.storageMode === "personalSavedMessages").length,
  };

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">Upload Files</CardTitle>
        <CardDescription>Drag and drop or click to select files</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Batch Summary */}
        {batchSummary && (
          <div className="bg-slate-700 rounded-lg p-3 text-sm text-slate-300">
            <p className="font-medium mb-1">
              {batchSummary.total} file{batchSummary.total !== 1 ? "s" : ""}: {batchSummary.botCount} to Image Storage, {batchSummary.personalCount} to Video Storage
            </p>
          </div>
        )}

        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-lg p-8 text-center transition ${
            isDragging
              ? "border-blue-500 bg-blue-500/10"
              : "border-slate-600 hover:border-slate-500"
          }`}
        >
          <Cloud className="w-12 h-12 text-slate-400 mx-auto mb-3" />
          <p className="text-white font-medium mb-1">Drop files here to upload</p>
          <p className="text-sm text-slate-400 mb-4">or</p>
          <Button
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            className="text-slate-300"
          >
            <Upload className="w-4 h-4 mr-2" />
            Select Files
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>

        {/* Uploading Files */}
        {uploadingFiles.length > 0 && (
          <div className="space-y-3 pt-4 border-t border-slate-700">
            {uploadingFiles.map((file) => (
              <div key={file.id} className="space-y-2 p-3 bg-slate-700/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300 truncate flex-1">{file.name}</span>
                  <span className="text-xs text-slate-400 ml-2">{file.progress}%</span>
                </div>

                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${file.progress}%` }}
                  />
                </div>

                {/* Routing Badge with Popover */}
                <div className="flex items-center gap-2">
                  <Popover open={expandedFileId === file.id} onOpenChange={(open) => setExpandedFileId(open ? file.id : null)}>
                    <PopoverTrigger asChild>
                      <button className="inline-flex items-center gap-1 px-2 py-1 rounded bg-slate-600 hover:bg-slate-500 transition text-xs text-slate-200">
                        {getStorageIcon(file.storageMode)}
                        <span>{file.displayName}</span>
                        <Info className="w-3 h-3" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 bg-slate-700 border-slate-600 text-slate-200">
                      <div className="space-y-3">
                        <div>
                          <p className="text-sm font-medium text-white mb-1">Routing Decision</p>
                          <p className="text-xs text-slate-300">{file.explanation}</p>
                        </div>

                        {file.canOverride && file.overrideOptions && (
                          <div>
                            <p className="text-xs font-medium text-slate-300 mb-2">Store somewhere else:</p>
                            <div className="space-y-1">
                              {file.overrideOptions.map((option) => (
                                <button
                                  key={option}
                                  className="w-full text-left px-2 py-1 text-xs rounded bg-slate-600 hover:bg-slate-500 transition text-slate-200"
                                  onClick={() => {
                                    // Handle override
                                    setUploadingFiles((prev) =>
                                      prev.map((f) =>
                                        f.id === file.id
                                          ? {
                                              ...f,
                                              storageMode: option,
                                              displayName: option === "botStorage" ? "Image Storage" : "Video Storage",
                                            }
                                          : f
                                      )
                                    );
                                    setExpandedFileId(null);
                                    toast.success("Storage location updated");
                                  }}
                                >
                                  {getStorageIcon(option)}
                                  <span className="ml-1">
                                    {option === "botStorage" ? "Image Storage" : "Video Storage"}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        <p className="text-xs text-slate-400">
                          Size: {formatFileSize(file.size)}
                        </p>
                      </div>
                    </PopoverContent>
                  </Popover>

                  <span className="text-xs text-slate-400">{formatFileSize(file.size)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
