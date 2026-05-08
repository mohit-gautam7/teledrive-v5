import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cloud, HardDrive } from "lucide-react";

interface StorageStats {
  totalFiles: number;
  totalSize: number;
  botFiles: number;
  botSize: number;
  personalFiles: number;
  personalSize: number;
}

interface StorageSummaryProps {
  stats: StorageStats;
}

export function StorageSummary({ stats }: StorageSummaryProps) {
  const FIFTY_MB = 52428800;

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const botPercentage = Math.min((stats.botSize / FIFTY_MB) * 100, 100);
  const personalPercentage = Math.min((stats.personalSize / (2 * 1024 * 1024 * 1024)) * 100, 100);

  return (
    <Card className="bg-slate-800 border-slate-700">
      <CardHeader>
        <CardTitle className="text-white">Storage Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Bot Storage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Cloud className="w-5 h-5 text-blue-500" />
              <span className="text-sm font-medium text-white">Image Storage</span>
            </div>
            <span className="text-xs text-slate-400">{stats.botFiles} files</span>
          </div>
          <p className="text-xs text-slate-400">{formatFileSize(stats.botSize)} / {formatFileSize(FIFTY_MB)}</p>
          <div className="w-full bg-slate-700 rounded-full h-2 relative">
            <div
              className="bg-blue-500 h-2 rounded-full transition-all"
              style={{ width: `${botPercentage}%` }}
            />
            <div
              className="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-slate-500"
              style={{ left: "100%" }}
              title="50MB limit"
            />
          </div>
        </div>

        {/* Personal Storage */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-purple-500" />
              <span className="text-sm font-medium text-white">Video Storage</span>
            </div>
            <span className="text-xs text-slate-400">{stats.personalFiles} files</span>
          </div>
          <p className="text-xs text-slate-400">{formatFileSize(stats.personalSize)} / 2 GB</p>
          <div className="w-full bg-slate-700 rounded-full h-2">
            <div
              className="bg-purple-500 h-2 rounded-full transition-all"
              style={{ width: `${personalPercentage}%` }}
            />
          </div>
        </div>

        {/* Total */}
        <div className="pt-4 border-t border-slate-700">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-slate-300">Total</span>
            <span className="text-sm font-medium text-white">{stats.totalFiles} files</span>
          </div>
          <p className="text-xs text-slate-400">{formatFileSize(stats.totalSize)} used</p>
        </div>
      </CardContent>
    </Card>
  );
}
