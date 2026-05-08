import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setSessionCookie, signSession } from "@/lib/auth";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Dev login is disabled in production." }, { status: 404 });
  }

  const user = await prisma.user.upsert({
    where: { telegramId: "local-dev-user" },
    update: {
      name: "Local Developer",
      username: "local_dev"
    },
    create: {
      telegramId: "local-dev-user",
      name: "Local Developer",
      username: "local_dev"
    }
  });

  const response = NextResponse.json({ user });
  setSessionCookie(response, signSession(user));
  return response;
}
