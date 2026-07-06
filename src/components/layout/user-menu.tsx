"use client";

import { LogOut, User } from "lucide-react";
import { signOut } from "next-auth/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

export function UserMenu({ name, email }: { name: string; email: string }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted focus:outline-none">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <User className="h-4 w-4" />
          </span>
          <span className="hidden font-medium sm:inline">{name}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-50 min-w-[200px] rounded-md border border-border bg-background p-1 shadow-md"
        >
          <div className="px-2 py-1.5">
            <p className="text-sm font-medium">{name}</p>
            <p className="text-xs text-muted-foreground">{email}</p>
          </div>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-muted"
            onSelect={() => signOut({ callbackUrl: "/" })}
          >
            <LogOut className="h-4 w-4" /> Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
