import type { Metadata } from "next";
import { UserGuide } from "@/components/guide/user-guide";

export const metadata: Metadata = {
  title: "User guide",
  description:
    "Learn how to plan, screen, extract, synthesize, collaborate, write, and compile systematic reviews and multi-PICO guidelines in Synthesis.",
};

export default function GuidePage() {
  return <UserGuide />;
}
