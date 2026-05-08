import { useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Cloud, Upload, AlertCircle } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";

export function UploadZone() {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFiles, setUploadingFiles] = useState<Array<{
    name: string;
    size: number;
    progress: number;
    storageMode: string;
  }>>([]);

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
    for (const file of files) {
      const newFile = {
        name: file.name,
        size: file.size,
        progress: 0,
        storageMode: "Determining...",
      };

      setUploadingFiles((prev) => [...prev, newFile]);

      // Get routing decision
      try {
        const decision = await getRoutingDecision.refetch();
        if (decision.data) {
          setUploadingFiles((prev) =>
            prev.map((f) =>
              f.name === file.name
                ? { ...f, storageMode: decision.data.displayName }
                : f
            )
          );
        }
      } catch (error) {
        console.error("Failed to get routing decision:", error);
        toast.error("Failed to determine storage location");
      }

      // Simulate upload progress
      for (let i = 0; i <= 100; i += 10) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        setUploadingFiles((prev) =>
          prev.map((f) =>
            f.name === file.name ? { ...f, progress: i } : f
          )
        );
      }

      // Remove from uploading list after completion
      setTimeout(() => {
        setUploadingFiles((prev) => prev.filter((f) => f.name !== file.name));
        toast.success(`${file.name} uploaded successfully`);
      }, 500);
    }
  };

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">Upload Files</CardTitle>
        <CardDescription>Drag and drop or click to select files</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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

        {uploadingFiles.length > 0 && (
          <div className="space-y-3 pt-4 border-t border-slate-700">
            <p className="text-sm text-slate-300 font-medium">
              Uploading {uploadingFiles.length} file(s)
            </p>
            {uploadingFiles.map((file) => (
              <div key={file.name} className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-slate-300 truncate">{file.name}</span>
                  <span className="text-xs text-slate-400">{file.progress}%</span>
                </div>
                <div className="w-full bg-slate-700 rounded-full h-2">
                  <div
                    className="bg-blue-500 h-2 rounded-full transition-all"
                    style={{ width: `${file.progress}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400">{file.storageMode}</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
