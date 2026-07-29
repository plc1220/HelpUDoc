import type { Metadata } from "next";
import { HelpUDocPrototype } from "./HelpUDocPrototype";

export const metadata: Metadata = {
  title: "HelpUDoc Governance UI Prototype",
  description:
    "A clickable HelpUDoc interface simulation for published-workspace collaboration, skill, knowledge, MCP, and sandbox governance scenarios.",
};

export default function Home() {
  return <HelpUDocPrototype />;
}
