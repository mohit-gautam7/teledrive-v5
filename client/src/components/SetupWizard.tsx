import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Cloud, Video, CheckCircle2, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";

interface SetupWizardProps {
  onComplete: () => void;
}

export default function SetupWizard({ onComplete }: SetupWizardProps) {
  const [step, setStep] = useState<"welcome" | "bot" | "personal" | "complete">("welcome");
  const [botToken, setBotToken] = useState("");
  const [botChannelId, setBotChannelId] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");

  const updateBotConfig = trpc.storage.updateBotConfig.useMutation();
  const updatePersonalConfig = trpc.storage.updatePersonalConfig.useMutation();

  const handleBotSetup = async () => {
    if (!botToken || !botChannelId) {
      alert("Please fill in all fields");
      return;
    }

    try {
      await updateBotConfig.mutateAsync({
        botToken,
        botUsername: "TeleDrive Bot",
        botChannelId,
        botChannelName: "TeleDrive Storage",
      });
      setStep("personal");
    } catch (error) {
      alert("Failed to save bot configuration");
    }
  };

  const handlePersonalSetup = async () => {
    if (!phoneNumber) {
      alert("Please enter your phone number");
      return;
    }

    try {
      await updatePersonalConfig.mutateAsync({
        phoneNumber,
        personalStorageMode: "savedMessages",
      });
      setStep("complete");
    } catch (error) {
      alert("Failed to save personal configuration");
    }
  };

  if (step === "welcome") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6 flex items-center justify-center">
        <div className="max-w-2xl w-full">
          <div className="text-center mb-12">
            <h1 className="text-4xl font-bold text-white mb-2">Let's set up your TeleDrive</h1>
            <p className="text-slate-400 text-lg">Just 3 minutes to get started</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <Card className="bg-slate-800 border-slate-700 hover:border-blue-500 transition cursor-pointer">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Cloud className="w-8 h-8 text-blue-500" />
                    <div>
                      <CardTitle className="text-white">Image Storage</CardTitle>
                      <CardDescription>For your photos and documents</CardDescription>
                    </div>
                  </div>
                  <span className="text-lg font-bold text-slate-400">1</span>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-300 mb-4">Up to 50MB per file</p>
                <p className="text-xs text-slate-400">Status: Not set up yet</p>
              </CardContent>
            </Card>

            <Card className="bg-slate-800 border-slate-700 hover:border-purple-500 transition cursor-pointer">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Video className="w-8 h-8 text-purple-500" />
                    <div>
                      <CardTitle className="text-white">Video Storage</CardTitle>
                      <CardDescription>For your videos and large files</CardDescription>
                    </div>
                  </div>
                  <span className="text-lg font-bold text-slate-400">2</span>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-slate-300 mb-4">Up to 2GB per file</p>
                <p className="text-xs text-slate-400">Status: Not set up yet</p>
              </CardContent>
            </Card>
          </div>

          <p className="text-center text-slate-400 mb-8">
            You can set up one now and add the other later. The system automatically routes files to the right place.
          </p>

          <Button
            size="lg"
            className="w-full bg-blue-600 hover:bg-blue-700 text-white"
            onClick={() => setStep("bot")}
          >
            Start Setup
          </Button>
        </div>
      </div>
    );
  }

  if (step === "bot") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6 flex items-center justify-center">
        <div className="max-w-md w-full">
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-white mb-2">Set Up Image Storage</h2>
            <p className="text-slate-400">Create a bot for storing images and documents</p>
          </div>

          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="botToken" className="text-white">Bot Token</Label>
                <Input
                  id="botToken"
                  placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
                  value={botToken}
                  onChange={(e) => setBotToken(e.target.value)}
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500"
                />
                <p className="text-xs text-slate-400">Get this from @BotFather on Telegram</p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="botChannelId" className="text-white">Channel ID</Label>
                <Input
                  id="botChannelId"
                  placeholder="-1001234567890"
                  value={botChannelId}
                  onChange={(e) => setBotChannelId(e.target.value)}
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500"
                />
                <p className="text-xs text-slate-400">Create a private channel and add your bot</p>
              </div>

              <Button
                className="w-full bg-blue-600 hover:bg-blue-700"
                onClick={handleBotSetup}
                disabled={updateBotConfig.isPending}
              >
                {updateBotConfig.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (step === "personal") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6 flex items-center justify-center">
        <div className="max-w-md w-full">
          <div className="mb-8">
            <h2 className="text-3xl font-bold text-white mb-2">Set Up Video Storage</h2>
            <p className="text-slate-400">Connect your Telegram account for video storage</p>
          </div>

          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6 space-y-6">
              <div className="space-y-2">
                <Label htmlFor="phoneNumber" className="text-white">Phone Number</Label>
                <Input
                  id="phoneNumber"
                  placeholder="+1234567890"
                  value={phoneNumber}
                  onChange={(e) => setPhoneNumber(e.target.value)}
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-500"
                />
                <p className="text-xs text-slate-400">Your Telegram phone number</p>
              </div>

              <Button
                className="w-full bg-purple-600 hover:bg-purple-700"
                onClick={handlePersonalSetup}
                disabled={updatePersonalConfig.isPending}
              >
                {updatePersonalConfig.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Continue"
                )}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800 p-6 flex items-center justify-center">
      <div className="max-w-md w-full text-center">
        <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-6" />
        <h2 className="text-3xl font-bold text-white mb-2">You're all set!</h2>
        <p className="text-slate-400 mb-8">Your TeleDrive is ready to use. Start uploading files now.</p>

        <Button
          size="lg"
          className="w-full bg-blue-600 hover:bg-blue-700"
          onClick={onComplete}
        >
          Go to Dashboard
        </Button>
      </div>
    </div>
  );
}
