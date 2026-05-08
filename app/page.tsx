import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import Login from "@/components/login";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) redirect("/drive");
  return <Login />;
}
