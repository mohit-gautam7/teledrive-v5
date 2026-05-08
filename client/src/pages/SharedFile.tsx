import { useParams } from "wouter";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Download, Cloud, HardDrive, Lock } from "lucide-react";
import { toast } from "sonner";

export default function SharedFile() {
  const { token } = useParams<{ token: string }>();
  const [file, setFile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSharedFile = async () => {
      try {
        setLoading(true);
        // In a real implementation, this would call an API endpoint
        // For now, we'll show a placeholder
        setFile({
          name: "shared-file.pdf",
          size: 2048576,
          storageMode: "botStorage",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        });
      } catch (err) {
        setError("Failed to load shared file");
        toast.error("Failed to load shared file");
      } finally {
        setLoading(false);
      }
    };

    if (token) {
      fetchSharedFile();
    }
  }, [token]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
          <p className="text-slate-300">Loading shared file...</p>
        </div>
      </div>
    );
  }

  if (error || !file) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 flex items-center justify-center p-4">
        <Card className="bg-slate-800 border-slate-700 max-w-md w-full">
          <CardContent className="pt-12 text-center">
            <Lock className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <p className="text-white font-semibold mb-2">File Not Found</p>
            <p className="text-slate-400 text-sm mb-6">
              {error || "This shared file link is invalid or has expired."}
            </p>
            <Button
              className="bg-blue-600 hover:bg-blue-700"
              onClick={() => window.location.href = "/"}
            >
              Go Home
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
      <div className="max-w-2xl mx-auto">
        <Card className="bg-slate-800 border-slate-700">
          <CardHeader>
            <CardTitle className="text-white">Shared File</CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* File Info */}
            <div className="space-y-4">
              <div className="flex items-center gap-4 p-4 rounded-lg bg-slate-700">
                {file.storageMode === "botStorage" ? (
                  <Cloud className="w-8 h-8 text-blue-500 flex-shrink-0" />
                ) : (
                  <HardDrive className="w-8 h-8 text-purple-500 flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-white font-medium truncate">{file.name}</p>
                  <p className="text-sm text-slate-400">{formatFileSize(file.size)}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-slate-400">Storage Type</p>
                  <p className="text-white font-medium">
                    {file.storageMode === "botStorage" ? "Image Storage" : "Video Storage"}
                  </p>
                </div>
                <div>
                  <p className="text-slate-400">Shared On</p>
                  <p className="text-white font-medium">{formatDate(file.createdAt)}</p>
                </div>
              </div>

              {file.expiresAt && (
                <div className="p-3 rounded-lg bg-yellow-900/20 border border-yellow-700/30">
                  <p className="text-sm text-yellow-300">
                    This link expires on {formatDate(file.expiresAt)}
                  </p>
                </div>
              )}
            </div>

            {/* Download Button */}
            <Button
              size="lg"
              className="w-full bg-blue-600 hover:bg-blue-700"
              onClick={() => {
                toast.success("Download started");
              }}
            >
              <Download className="w-4 h-4 mr-2" />
              Download File
            </Button>

            {/* Info */}
            <p className="text-xs text-slate-400 text-center">
              This is a shared file from TeleDrive. The owner can revoke access at any time.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
