import { createRoot } from "react-dom/client";
import { HelpUDocPrototype } from "./HelpUDocPrototype";

const root = document.getElementById("helpudoc-demo");

if (!root) {
  throw new Error("HelpUDoc demo root was not found");
}

createRoot(root).render(<HelpUDocPrototype />);
