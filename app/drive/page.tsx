import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import DriveApp from "@/components/drive-app";

export default async function DrivePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/");
  return <DriveApp user={{ name: user.name, username: user.username, avatar: user.avatar }} />;
}
