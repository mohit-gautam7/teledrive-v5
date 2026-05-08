import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Plus, Cloud, Video, HardDrive, LogOut, Trash2, Edit2 } from "lucide-react";
import { FileGrid } from "@/components/FileGrid";
import { StorageSummary } from "@/components/StorageSummary";
import { AdvancedUploadZone } from "@/components/AdvancedUploadZone";
import { toast } from "sonner";

export default function Dashboard() {
  const { logout } = useAuth();
  const [selectedFolderId, setSelectedFolderId] = useState<number | undefined>();
  const [editingFolderId, setEditingFolderId] = useState<number | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");

  const filesQuery = trpc.files.list.useQuery({
    folderId: selectedFolderId,
  });

  const foldersQuery = trpc.folders.list.useQuery({
    parentId: selectedFolderId,
  });

  const statsQuery = trpc.files.getStats.useQuery();

  const createFolderMutation = trpc.folders.create.useMutation({
    onSuccess: () => {
      foldersQuery.refetch();
      toast.success("Folder created");
    },
  });

  const renameFolderMutation = trpc.folders.rename.useMutation({
    onSuccess: () => {
      foldersQuery.refetch();
      setEditingFolderId(null);
      toast.success("Folder renamed");
    },
  });

  const deleteFolderMutation = trpc.folders.delete.useMutation({
    onSuccess: () => {
      foldersQuery.refetch();
      toast.success("Folder deleted");
    },
  });

  const handleCreateFolder = () => {
    const name = prompt("Folder name:");
    if (name) {
      createFolderMutation.mutate({
        name,
        parentId: selectedFolderId,
      });
    }
  };

  const handleRenameFolder = (folderId: number, currentName: string) => {
    setEditingFolderId(folderId);
    setEditingFolderName(currentName);
  };

  const handleSaveRename = (folderId: number) => {
    if (editingFolderName.trim()) {
      renameFolderMutation.mutate({
        folderId,
        name: editingFolderName.trim(),
      });
    }
  };

  const handleDeleteFolder = (folderId: number) => {
    if (confirm("Delete this folder and all its contents?")) {
      deleteFolderMutation.mutate({ folderId });
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      {/* Header */}
      <header className="bg-slate-800 border-b border-slate-700 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <HardDrive className="w-8 h-8 text-blue-500" />
            <h1 className="text-2xl font-bold text-white">TeleDrive</h1>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={logout}
            className="text-slate-300"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 mb-8">
          {/* Main Content */}
          <div className="lg:col-span-3 space-y-6">
            {/* Upload Zone */}
            <AdvancedUploadZone />

            {/* Breadcrumb Navigation */}
            {selectedFolderId && (
              <div className="flex items-center gap-2 text-sm">
                <button
                  onClick={() => setSelectedFolderId(undefined)}
                  className="text-blue-400 hover:text-blue-300"
                >
                  All Files
                </button>
                <span className="text-slate-500">/</span>
                <span className="text-slate-300">Current Folder</span>
              </div>
            )}

            {/* Folders */}
            {foldersQuery.data && foldersQuery.data.length > 0 && (
              <Card className="bg-slate-800 border-slate-700">
                <CardHeader>
                  <CardTitle className="text-white">Folders</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {foldersQuery.data.map((folder) => (
                      <div
                        key={folder.id}
                        className="group relative"
                      >
                        {editingFolderId === folder.id ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editingFolderName}
                              onChange={(e) => setEditingFolderName(e.target.value)}
                              className="flex-1 px-2 py-1 rounded bg-slate-700 border border-slate-600 text-white text-sm"
                              autoFocus
                            />
                            <Button
                              size="sm"
                              className="bg-blue-600 hover:bg-blue-700"
                              onClick={() => handleSaveRename(folder.id)}
                            >
                              Save
                            </Button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={() => setSelectedFolderId(folder.id)}
                              className="w-full p-4 rounded-lg bg-slate-700 hover:bg-slate-600 transition text-left"
                            >
                              <p className="text-white font-medium truncate">{folder.name}</p>
                              <p className="text-xs text-slate-400 mt-1">Folder</p>
                            </button>
                            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition flex gap-1">
                              <button
                                onClick={() => handleRenameFolder(folder.id, folder.name)}
                                className="p-1 rounded bg-slate-600 hover:bg-slate-500 text-slate-300"
                              >
                                <Edit2 className="w-3 h-3" />
                              </button>
                              <button
                                onClick={() => handleDeleteFolder(folder.id)}
                                className="p-1 rounded bg-red-600 hover:bg-red-500 text-white"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Files Grid */}
            {filesQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
              </div>
            ) : filesQuery.data && filesQuery.data.length > 0 ? (
              <FileGrid files={filesQuery.data} />
            ) : (
              <Card className="bg-slate-800 border-slate-700">
                <CardContent className="pt-12 text-center">
                  <Cloud className="w-12 h-12 text-slate-600 mx-auto mb-4" />
                  <p className="text-slate-400">No files yet. Upload your first file to get started!</p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Storage Summary */}
            {statsQuery.data && <StorageSummary stats={statsQuery.data} />}

            {/* Quick Actions */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-lg">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <Button
                  className="w-full bg-blue-600 hover:bg-blue-700"
                  onClick={handleCreateFolder}
                  disabled={createFolderMutation.isPending}
                >
                  <Plus className="w-4 h-4 mr-2" />
                  New Folder
                </Button>
              </CardContent>
            </Card>

            {/* Storage Info */}
            <Card className="bg-slate-800 border-slate-700">
              <CardHeader>
                <CardTitle className="text-white text-sm">Storage Info</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-blue-500" />
                  <span className="text-slate-300">Image Storage: Up to 50MB</span>
                </div>
                <div className="flex items-center gap-2">
                  <Video className="w-4 h-4 text-purple-500" />
                  <span className="text-slate-300">Video Storage: Up to 2GB</span>
                </div>
                <p className="text-xs text-slate-400 pt-2 border-t border-slate-700">
                  Files are automatically routed based on type and size. You can override the routing during upload.
                </p>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
