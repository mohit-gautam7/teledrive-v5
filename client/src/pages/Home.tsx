import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Cloud, Video, HardDrive, AlertCircle } from "lucide-react";
import { getLoginUrl } from "@/const";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import Dashboard from "./Dashboard";
import SetupWizard from "@/components/SetupWizard";

export default function Home() {
  const { user, loading, isAuthenticated, logout } = useAuth();
  const [showSetup, setShowSetup] = useState(false);

  const storageConfig = trpc.storage.getConfig.useQuery(undefined, {
    enabled: isAuthenticated,
  });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-12 h-12 animate-spin text-blue-500" />
          <p className="text-slate-300">Loading TeleDrive...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-br from-slate-900 to-slate-800 px-4">
        <div className="max-w-md w-full space-y-8 text-center">
          <div className="space-y-2">
            <div className="flex justify-center gap-2 mb-4">
              <Cloud className="w-10 h-10 text-blue-500" />
              <HardDrive className="w-10 h-10 text-purple-500" />
            </div>
            <h1 className="text-4xl font-bold text-white">TeleDrive v5.0</h1>
            <p className="text-slate-300 text-lg">Smart Telegram File Storage</p>
          </div>

          <p className="text-slate-400">
            Store your files securely in Telegram. Images and documents in your bot channel, videos in your personal storage.
          </p>

          <div className="space-y-3">
            <Button
              size="lg"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => window.location.href = getLoginUrl()}
            >
              Sign in with Manus
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-4 pt-8">
            <Card className="bg-slate-800 border-slate-700">
              <CardContent className="pt-6 text-center">
                <Cloud className="w-8 h-8 text-blue-500 mx-auto mb-2" />
                <p className="text-sm font-semibold text-white">Bot Storage</p>
                <p className="text-xs text-slate-400">Up to 50MB</p>
              </CardContent>
            </Card>
            <Card className="bg-slate-800 border-slate-700">
              <CardContent className="pt-6 text-center">
                <Video className="w-8 h-8 text-purple-500 mx-auto mb-2" />
                <p className="text-sm font-semibold text-white">Personal Storage</p>
                <p className="text-xs text-slate-400">Up to 2GB</p>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    );
  }

  const config = storageConfig.data;
  // Graceful degradation: app works with at least one storage mode configured
  const needsSetup = !config?.isBotConfigured && !config?.isPersonalConfigured;
  const hasAtLeastOneStorage = config?.isBotConfigured || config?.isPersonalConfigured;

  if (needsSetup && !showSetup) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6">
        <div className="max-w-2xl mx-auto">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold text-white mb-2">Let's set up your TeleDrive</h1>
            <p className="text-slate-400">Just 3 minutes to get started</p>
          </div>

          <div className="space-y-4">
            <Button
              size="lg"
              className="w-full bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setShowSetup(true)}
            >
              Start Setup
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="w-full"
              onClick={logout}
            >
              Logout
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (showSetup) {
    return <SetupWizard onComplete={() => { setShowSetup(false); storageConfig.refetch(); }} />;
  }

  // Show dashboard with graceful degradation message if only one storage mode is configured
  return (
    <>
      {config && !config.isBotConfigured && (
        <div className="fixed top-0 left-0 right-0 bg-yellow-900/20 border-b border-yellow-700/30 p-3 z-40">
          <div className="max-w-7xl mx-auto flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-300 flex-shrink-0" />
            <p className="text-sm text-yellow-300 flex-1">
              Bot storage is not configured. Videos and large files will be stored in personal storage only.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="text-yellow-300 border-yellow-600 hover:bg-yellow-900/20"
              onClick={() => setShowSetup(true)}
            >
              Configure Now
            </Button>
          </div>
        </div>
      )}
      {config && !config.isPersonalConfigured && (
        <div className="fixed top-0 left-0 right-0 bg-yellow-900/20 border-b border-yellow-700/30 p-3 z-40">
          <div className="max-w-7xl mx-auto flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-300 flex-shrink-0" />
            <p className="text-sm text-yellow-300 flex-1">
              Personal storage is not configured. Images and small files will be stored in bot storage only.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="text-yellow-300 border-yellow-600 hover:bg-yellow-900/20"
              onClick={() => setShowSetup(true)}
            >
              Configure Now
            </Button>
          </div>
        </div>
      )}
      <Dashboard />
    </>
  );
}
