import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Button({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "inline-flex h-10 items-center justify-center gap-2 rounded-md border border-transparent px-4 text-sm font-medium transition disabled:pointer-events-none disabled:opacity-50",
        "bg-sky-600 text-white hover:bg-sky-700",
        className
      )}
      {...props}
    />
  );
}
